# 向量检索 + RRF 可行性研究（O-9，sop.md P3）

状态：研究完成（2026-11-16），待 Yorker 过拍板清单后开工。本文只给事实与顺序建议，不做实现。

## 0. 结论先行

| 待验项 | 结论 |
|---|---|
| 存储双实现（SQLite / Postgres） | SQLite 侧**可行且已本机验证**；Postgres 侧当前**零抽象层**（`Db = DatabaseSync` 贯穿 core/hub，decisions D-02 的"可换驱动"只是文档接缝），建议降级为"远期可选"，先砍掉双实现承诺 |
| 向量双实现（sqlite-vec / pgvector） | sqlite-vec **v0.1.9 可用**（本机 Windows + Node 24.9 + `node:sqlite` 冒烟全绿，含落盘重开）；pgvector 0.8 技术可行但随 PG 一并推迟 |
| SQLite→Postgres 迁移工具 | 无 PG 实现就没有迁移目标；建议改为「导出/导入 JSON 快照」（复用 `backup`/`integrity` 的思路），PG 真落地时再写导入端 |
| RRF | 纯应用层即可，**现有代码天然适配**：`searchAssets` 的排序本来就在 JS 里做（search.ts:177-186），双路各取 top-N 后 1/(k+rank) 融合，k=60 |

## 1. 现状（研究起点，全部实测来源在括号）

- 检索已不是纯 LIKE：**FTS5 trigram**（`asset_fts(title, tags, summary, body)`，0001.ts:175）+ <3 码点词的 LIKE 兜底（search.ts:149-161）；评分在 JS：标题 +3 > tags/summary +2 > body +1，deprecated ×0.5（search.ts:71-82）。
- 候选集截断 200（`CANDIDATE_CAP`，search.ts:20），最终 limit 默认 8 上限 20。
- FTS 同步点已齐：create/update/状态变更/purge 都走 `reindexFts`/`unindexFts`（asset.ts:313-326、477、684、938-941、961）——**embedding 同步可以挂在同一批钩子上**。
- 权限过滤是 SQL 谓词（`ACCESSIBLE_SQL`，access.ts:117-141）+ `status IN ('active','deprecated')` + 过期排除；向量路要复用同一套。
- 无 chunking 概念，`asset_version.content` 整篇进 FTS（≤256 KiB，hub config maxContentBytes）；无任何 LLM 通道（architecture.md:9「不代理 LLM 流量」）。
- SQLite 驱动是 `node:sqlite`，全仓库唯一 import 在 core/db.ts:1；迁移机制 `PRAGMA user_version` + BEGIN IMMEDIATE（db.ts:44-64），加表就是新迁移文件。

## 2. sqlite-vec 事实（外部 + 本机实测）

- 稳定版 **v0.1.9**（npm，2026-08 发布；main 在 0.1.10-alpha）。作者 Alex Garcia；ann 索引是 open tracking issue（#25），**当前只做精确暴力 KNN**。
- 用法：`CREATE VIRTUAL TABLE … USING vec0(embedding float[D] distance_metric=cosine)`；KNN `WHERE embedding MATCH ? AND k = ?`，向量以 float32 BLOB 绑定。支持 int8/bit 量化列。
- 规模封套：作者基准 1M 向量下 ≤1024 维 KNN <75ms；社区评估 ~250k×1024d 在商品硬件 <100ms。**团队知识库是千级资产**，差两个数量级，暴力扫描绰绰有余。
- **本机冒烟（2026-11-16，ck-vec-probe）**：Windows + Node 24.9.0 + `node:sqlite` DatabaseSync + sqlite-vec v0.1.9——扩展加载、vec0 建表、float32 BLOB 写入、cosine KNN、**close 后重开文件库再查**，全部通过。
- 已知坑（冒烟撞上的）：`node:sqlite` 把 JS number 绑定为 DOUBLE，vec0 的整型主键与 `k =` 约束只认整型——**写 SQL 时 `CAST(? AS INTEGER)`**；向量参数用 `Buffer.from(new Float32Array(...).buffer)`。
- 社区分叉（vlasky/sqlite-vec 0.2.6-alpha）在做 ann/优化，未评估；主仓库 alpha 活跃（2026-05 仍有提交）。

## 3. pgvector 事实（外部）

- 0.8 系列（2026）：HNSW + IVFFlat + `hnsw.iterative_scan`（过滤查询迭代扫，缓解"过滤丢召回"）；四种类型 `vector`（索引 ≤2000 维）/ `halfvec`（≤4000）/ `bit`（≤64000）/ `sparsevec`。
- 常见 embedding 模型 768–1536 维都在 2000 之内，直接 `vector(N)` + hnsw 即可。
- 结论：技术无风险，但**收益场景不存在**（千级向量）而成本是实打实的：PG 驱动、连接池、部署件、迁移工具、双代码路径。推迟。

## 4. 设计草图（开工时的落点，不是决定）

### 4.1 schema（migration 0002）

```
embedding_chunk(
  id INTEGER PRIMARY KEY,          -- 同时是 vec0 的 rowid
  asset_id TEXT NOT NULL,           -- → asset.id；purge/归档连带删
  version INTEGER NOT NULL,         -- 哪个版本算的
  seq_in_asset INTEGER NOT NULL,    -- 分块序号（阶段一恒 0）
  model TEXT NOT NULL, dims INTEGER NOT NULL,   -- 换模型=全量重算的依据
  FOREIGN KEY(asset_id) REFERENCES asset(id)
);
CREATE VIRTUAL TABLE embedding_vec USING vec0(embedding float[D] distance_metric=cosine);
-- rowid = embedding_chunk.id
```

分块策略阶段一**不分块**：整条资产（title + summary + content 截到 N 字）一个向量——和现在 FTS 的粒度一致，`knowledge_search` 返回粒度不变；大内容分块留给阶段二（256 KiB 的 wiki/codegraph 进来再说）。

### 4.2 检索流程（searchAssets 扩展）

```
双路并行：FTS5 现路（不动） + vec0 KNN（k = 40~64 overfetch）
两路各在 SQL 里过 ACCESSIBLE_SQL/status/expired 谓词后再取 top-N
  ——注意：vec0 不支持 join 过滤，做法是 KNN 多取（overfetch ×4）后在 JS 里过滤权限再截 N
JS 融合：score(d) = Σ 1/(60 + rank_r(d))，两路都在的天然靠前
embedding 缺失（未回填/模型未配）→ 自动退化为纯 FTS 现行为，零回归
```

现有 `scoreRow` 的字段加权保留给 FTS 路内部排序；RRF 只融合两路的 rank，语义更干净。

### 4.3 embedding 通道（与 O-7 同一道拍板题）

hub 的架构原则是「不代理 LLM 流量」，embedding 是唯一合理的例外候选。选项留给 Yorker：

| 选项 | 说明 | 代价/风险 |
|---|---|---|
| A. 外置 worker | `ck embeddings backfill` 或 CI/cron 进程调模型 API，把向量写回 hub（新 action `embedding/put`，SA/owner 权限） | 不破架构原则；检索时数据可能滞后 |
| B. hub 配 endpoint | config 加 `embedding: { url, key, model }`，hub 在 reindexFts 钩子里同步调 | 破「不代理 LLM 流量」，但回填即时；O-7 若也走 hub 通道，两项一起定 |
| C. 本地 ONNX（transformers.js / fastembed） | 零外部依赖、离线可用 | 新 native 依赖（onnxruntime），中文模型体积 ~100MB+，与"轻依赖"哲学冲突 |

模型本身建议**先用 openai-compatible 接口形状**（`/v1/embeddings`），具体模型（bge-m3 / text-embedding-3 / 自部署）由 LY 的网关决定——和 codex 走 magpie 网关同款思路。

### 4.4 同步与回填

- 增量：`reindexFts` 的四个钩子点各加 `reindexEmbedding`（A 选项下变成"标记待算"）。
- 全量：一个回填命令（hub action 或 ck 子命令），按 `embedding_chunk.version ≠ asset.current_version` 补差。
- purge：`unindexFts` 同点删 `embedding_chunk` + vec0 行。

## 5. 实现顺序建议

1. **schema + 存取层**（core migration 0002、vec0 建表、CAST/float32 封装进 db.ts 一处）——无行为变化。
2. **检索双路 + RRF**（searchAssets 扩展，embedding 缺失时降级纯 FTS）——不依赖通道拍板，可用手写向量单测。
3. **embedding 通道**（Yorker 拍 A/B/C 后）+ 回填命令。
4. ~~PG 双实现 + 迁移工具~~ → 改为：**导出/导入 JSON 快照**（若真出现多实例/大库需求再立 PG 规格，本文 §3 就是那时的起点）。

每步独立可测：1 用 migration 测试，2 用 search.test.ts 加向量 fixture（固定小维度如 float[4] 假向量，不调真模型），3 才涉及真模型。

## 6. 待拍板清单（Yorker）

1. embedding 通道 A/B/C（与 O-7 模型通道联动拍）。
2. 分块粒度：阶段一整条资产，是否接受（阶段二 wiki/codegraph 再分块）。
3. PG 双实现降级为"远期可选"、迁移工具改为 JSON 快照——这是对 sop.md 242 原文「存储双实现/向量双实现/迁移工具」三承诺的**缩减**，需要显式点头。
4. overfetch 倍数与 k（建议 4×、RRF k=60，可后调）。
5. 检索降级语义：embedding 缺失 = 纯 FTS（不报错不提示），panel/CLI 是否要透出"向量检索未启用"状态（doctor 或 usage 页）。

## 7. 来源

- 本仓库：core/src/search.ts、core/src/db.ts、core/src/migrations/0001.ts、core/src/asset.ts、hub/src/actions.ts:476（实测行号见 §1）。
- sqlite-vec：github.com/asg017/sqlite-vec（releases v0.1.9 / main 0.1.10-alpha.4）、npm sqlite-vec 0.1.9、作者博客 alexgarcia.xyz（v0.1.0 基准与 KNN 语法）、issue #25（ann 无索引）、dev.to node:sqlite + sqlite-vec 实践（Node ≥22.18）。
- pgvector：github.com/pgvector/pgvector（类型与维度上限）、jkatz.github.io 与 dbi-services（量化与 2000 维墙）、0.8 iterative_scan（clickhouse 工程博客）。
- RRF：原论文口径 k=60；SQL ROW_NUMBER 模式（paradedb / bigdataboutique / doris 文档）；SQLite FTS5+vec0+RRF 应用层融合实例（joinloop.co.in）。
- 本机冒烟：`%TEMP%\ck-vec-probe\smoke.mjs`（2026-11-16，Windows + Node 24.9.0，v0.1.9，含落盘重开）。
