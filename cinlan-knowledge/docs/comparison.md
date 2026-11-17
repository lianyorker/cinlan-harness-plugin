# 生态对比

结论先行：模型照腾讯 Memory Hub（资产 + 可见性 + 配装）；在它之上加一道共享审批；运行面走 MCP + `ck`，一套实现兼容多个 agent harness / agent CLI；检索与自动抽取先做最小可用，后续参照 mcp-memory-service、Graphiti、Hindsight 升级。MCP 生态的几家是个人记忆原语，不解决"团队里谁能看、谁的 Agent 带什么"。

## 总表

| | cinlan-knowledge | Tencent Memory Hub | mcp-memory（官方参考） | mcp-memory-service | Graphiti | Cognee | Hindsight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 定位 | 团队 Agent 记忆中枢 | 团队记忆资产平台 | MCP 记忆原语 | 单服务全传输记忆后端 | 时序知识图谱引擎 | ECL 记忆管线 + MCP | 记忆学习引擎（retain / recall / reflect） |
| 数据模型 | 资产（memory / skill）+ 版本 + 可见性 + ACL | 统一记忆资产：Chat Memory / Skill / Wiki / CodeGraph | entity / relation / observation | 带 tag 与时间戳的记忆块 | episode → 实体 / 边（双时序） | chunk → embedding → KG | world facts / experiences / observations / mental models；bank 硬隔离 |
| 存储 | SQLite 单文件 | 未验证 | JSONL 单文件 | SQLite-vec / Cloudflare | Neo4j / FalkorDB | SQLite + LanceDB / PG | 未验证（storage 抽象 + 专用索引） |
| 身份与授权 | User Key；System Admin / Team Admin / Member；四档可见性 + ACL | User Key；System Admin / 团队 Admin / Member；四档可见性 + ACL | 无 | 单 API key | 无（README 明示勿暴露） | 租户 / dataset ACL | bank 隔离；Memory Defense 脱敏；无团队角色 / 审批 |
| 写入 | 默认 private 直写；共享过审 | 默认 private；共享是显式动作 | 模型直写 | store，可选自动固化 | add_memory → LLM 抽取 | remember → cognify | retain → LLM 抽实体 / 时序 / 关系 → 归一化 |
| 配装 | 固定绑定 + ACL；模板拷贝 + 显式下发 | Fixed Binding + ACL；团队默认模板 | 无 | 无 | 无 | 无 | 无（pages 是 bank 内自更新文档，非分发） |
| 检索 | FTS5 BM25（trigram）+ 短词兜底；向量 P3 | BM25 + 向量 + RRF | 子串匹配 | 向量 + BM25 混合，ranked 重排 | 混合 + RRF，图距 / cross-encoder 重排 | 向量 + 图 + LLM | 向量 + BM25 + 图 + 时序四路 + RRF + cross-encoder；自训 decide / rerank / embed 模型 |
| 分层 | `core / profile / atom` 字段；L0 抽取 P3 | L0 → L1 → L2 → L3 自动抽取 | 无 | 无 | episode / 实体 | session / permanent | facts / experiences / observations / mental models |
| 消费 | 会话开始注入（hook 或 `instructions`）+ 工具 + skill 物化；`ck` 统一 | Proxy 注入 + 工具；各宿主插件；MCP | 模型工具 | 工具 + session hooks 注入 | 工具 | 工具 | recall / reflect 工具 + mental model 直读 |
| 分发面 | RPC API + MCP（stdio 与远端）+ `ck` 分发包 + panel | REST + MCP + Proxy + SDK | MCP stdio | MCP + REST + CLI + dashboard | MCP HTTP | MCP + REST | REST + Python / Node / Go SDK + MCP + CLI + webhooks |
| 宿主覆盖 | dsh / Claude Code / Codex CLI / Gemini CLI / 任意 MCP 宿主（dsh 与 Claude Code 已核对到源码/文档级） | 7 类客户端（Proxy 适配） | 任意 MCP 宿主 | 主要 Claude Code / Codex hooks | 任意 MCP 宿主 | 任意 MCP 宿主 | 任意 MCP / REST 宿主 |
| 控制台 | 资产库 / 配装 / 团队 / 审批 / 访问控制 / 用量 | 六个玩法 | 无 | dashboard | 无 | 有 | admin CLI + Cloud；无治理面板 |

## 各参照系的取舍

### Tencent Memory Hub

主参照。取舍逐条列在 [decisions.md](decisions.md) §3。三处有意不同：

1. 运行面走 MCP + `ck`，不站到 LLM 流量路径上；Proxy 与各宿主插件降为 P3 可选（D-08）。
2. 共享加审批（D-05）。已读的腾讯文档里共享是 Owner 的显式动作，未见审批流。
3. 单进程单端口、单 SQLite 文件，不拆 Core / Knowledge / Panel / Proxy 四个服务。

### mcp-memory（官方参考 server）

- 借鉴：`search_nodes` / `open_nodes` 的两段式，对应我们的 `knowledge_search` / `knowledge_open`。
- 不取：模型直写的 KG。个人助手够用，团队共享不行。

### mcp-memory-service（doobidoo）

- 印证：session-start 注入这条路是对的，我们的读档注入同型；MCP + REST 同服务出也是对的，我们做成 `/mcp` + `/api/v1` 同端口。
- 借鉴（后续）：tag 的 AND / OR 过滤、recency 与 quality 参与排序。
- 不取（v1）：向量栈。先看 FTS 的实测召回。

### Graphiti

- 印证：`group_id` 是软隔离、README 明示无认证勿暴露——没有治理的记忆服务进不了团队。
- 借鉴（P3）：episode → 抽取 → 可溯源的做法，对应我们 L0 → 草稿并在 `source` 里留 `session_id`。
- 不取：图数据库与双时序。

### Cognee

- 借鉴：session 与 permanent 的分层视角，对应我们 `draft`（自动沉淀、仅自己可见）与 `active`。
- 不取：cognify 管线。

### Hindsight（vectorize-io）

- 不取：biomimetic 四层数据结构与 retain 的 LLM 抽取管线整套；bank 硬隔离模型——bank 之间没有共享概念，与我们的团队可见性模型相反。
- 借鉴（P3）：observations 的"带证据与 proof count 的信念，新证据 refine 而非覆盖"；pages 的自更新常驻文档；recall 四路并行 + RRF + cross-encoder 的组合；Memory Defense 的写入侧 secrets / PII 扫描——可做共享审批前的自动预检；decision model 思路——用专用小模型做"是否新事实 / 哪条更相关"这类小判断。
- 定位：记忆智能引擎，不是治理与分发面。LongMemEval SOTA，MIT，论文 arXiv:2512.12818 可复现思路。P3 若要全量记忆智能，"参考它自研"与"把它包进资产层当后端"是两条候选路，开工前按 O-7 拍。

## 我们多出来的东西

1. **共享审批**：team 可见内容会进所有成员 Agent 的上下文，这一步有人把关。
2. **服务端生成的注入计划**：预算、排序、降级只实现一次，所有宿主拿到逐字节一致的文本与 digest。
3. **一套客户端覆盖多宿主**：`ck` + `agents/<host>/host.json` 声明，新增宿主不改代码；腾讯为此维护 Proxy 里的 7 个协议适配器。
4. **自动沉淀只落私有草稿**：模型写得再多，也到不了团队上下文，除非人采纳并共享。
5. **部署极简**：一个进程、一个端口、一个数据库文件，客户端零依赖运行时。

## 我们暂时落后的地方

| 项 | 差距 | 计划 |
| --- | --- | --- |
| 检索 | 无向量、无 RRF、无重排 | P3 评估，先看 FTS 实测；存储双实现（SQLite / Postgres），向量 `sqlite-vec` / `pgvector` 分档，含迁移路径，见 [decisions.md](decisions.md) O-9 |
| 自动抽取 | 无 L0 → L3 管线 | P3 做 L0 → 草稿 |
| 记忆智能 | 无信念聚合 / 矛盾消解 / 自更新文档（Hindsight 的 observations / pages 已是 SOTA 形态） | P3 借概念落进现有 draft → active 状态机 |
| 宿主覆盖的实测广度 | dsh 与 Claude Code 核对到源码 / 文档级；Codex / Gemini 待 P2 spike；OpenCode / Cursor 未验证 | P2 补两个宿主，其余按 [hosts.md](hosts.md) §7 逐个接 |
| 不装 `ck` 时的体验 | 只能走远端 MCP：没有 skill 物化，读档效果取决于宿主怎么用 `instructions` | 接受；`ck` 是首选 |
| 知识类资产 | 无 wiki / codegraph | P4 |

## P3 之后还剩什么（v2 展望）

按 [sop.md](sop.md) 分期，P3 完成后功能矩阵与腾讯对齐约九成。剩余缺口分四类：

| 类别 | 内容 | 性质 |
| --- | --- | --- |
| 已排期 | wiki / codegraph、Knowledge Workshop | P4 |
| 深层记忆智能 | observations 式信念聚合（带证据、refine 不覆盖）、reflect 综合推理、mental models / pages 自更新文档、矛盾消解与时效失效 | P3 只做了输入侧（L0→草稿）；输出侧是 v2 级工程——2026-11-16 研究见 [deep-memory.md](deep-memory.md)（时效失效已全有、pages 形态已对齐，v2 工程量收敛到 reflect 提议回路 + evidence trail 两条） |
| 企业级能力 | SSO / OIDC、多实例与 HA、task 域 / 实例配额、Python / Java SDK | 现为刻意不做（[blueprint.md](blueprint.md) §7）；企业采购会拿功能矩阵对表，接企业前需重审 |
| 生态与背书 | benchmark 证据、生产案例、agent 框架集成（LangChain / CrewAI 等）、托管形态 | 非代码缺口，只能靠实际部署积累 |

纪律：上表任何一项开工前，必须先回到本文与 [blueprint.md](blueprint.md) / [decisions.md](decisions.md) 补分析、补规格、过拍板，再写代码（同 [sop.md](sop.md) A.0「偏离先改文档」）。

全实现后的相对位置：治理 + 配装 + 深度智能 + 多宿主四项同时具备的，市面没有直接对标——对腾讯是审批与部署面的超集，对 Hindsight 补上了它没有的治理与分发面；剩余差距只剩 benchmark / 案例 / 社区积累，属时间成本非架构成本。
