# 深层记忆智能研究（sop.md 250，v2 级）

状态：研究完成（2026-11-16），规格性结论供 v2 开工时过拍板。对照物是 [comparison.md](comparison.md) §Hindsight 与 sop.md 250 列的四个概念：observations 信念聚合、reflect、mental models / pages、矛盾消解与时效失效。

## 0. 结论先行

| 概念 | 我们已有的 | 真实缺口 | 定性 |
|---|---|---|---|
| **pages / mental models**（自更新常驻页） | `core` 层 memory 天然常驻注入 + 版本历史 + update 提议走审批（review kind=update 含 diff 视图）——**形态已对齐**，且外部有强印证（见 §1） | 缺"自动重写**提议**"的触发侧（reflect 的输出怎么进来） | **v2 主线**，且能整个复用现有 review update 流 |
| **observations**（带证据与 proof count 的信念，refine 不覆盖） | `atom` 层（单条事实，按需检索）+ 版本只追加从不覆盖 | 缺证据指针（草稿的 `source.session_id`，auto-distill 已计划）与**信念强度**（同事实多源计数） | 挂在 O-7 的 evidence trail 上延伸，不单独立项 |
| **reflect**（跨会话综合推理） | 无 | 整条回路：何时触发、输入什么（近 N 份会话报告）、输出什么（update 提议 / 新 atom 草稿） | **v2 的核心工程量**，通道依赖 O-7 |
| **矛盾消解** | 人审位全有：版本历史、update 提议、deprecated ×0.5 降权、B.6 月度治理 | 自动检测（"这是新事实还是与既有矛盾"——Hindsight 的 decision model 小判断） | 只做**检测→提议**，裁决永远留给人 |
| **时效失效** | **已全有**：`expires_at`（检索/配装等同不可读，owner 可续期）、deprecate / archive 状态机、/usage 零用量清单 + B.6 月度节奏 | 无（缺的只是自动化提示，属产品打磨） | **不需要 v2 工程**，本项关闭 |

一句话：**四概念里时效失效白捡、pages 形态已对齐，v2 真正的工程量只有 reflect 回路 + 证据轨迹两条，且全部依赖 O-7 通道拍板。**

## 1. 对照物事实（Hindsight，vectorize-io）

- 论文《Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects》arXiv:2512.12818（preprint，2025-12-14）；MIT 开源（github.com/vectorize-io/hindsight），Python/Node/Go + Postgres/pgvector，**LLM 必需**，bank 硬隔离多租户。
- 核心机制（论文 + 官方博客 + 第三方研究笔记交叉核实）：
  - **observations**：证据背书的信念，带 **proof count**；纠正时**refine 而非覆盖**，支持引语保留——"consolidation over replacement" 是其自称最好的想法。
  - **mental models / knowledge pages**：随学习持续重写的常驻 markdown 页。
  - **recall**：四路并行——semantic（向量）/ keyword（BM25）/ graph（链接扩散）/ temporal（日期区间）——+ RRF + cross-encoder 重排。
  - **reflect**：跨会话抽象再加工（"Reflect is the Pitch"）。
  - **Memory Defense**：写入侧 secrets / PII 扫描；**decision model**：专用小模型做"是否新事实 / 哪条更相关"类小判断。
- 外部印证（对我们要做的事最有价值的一条）：第三方研究（akitaonrails ai-memory 系列）结论——**"agent 记忆的持久单元是持续维护的定论式 markdown 页，不是原子事实袋子"**，两个不同起点的团队殊途同归。我们的 `core` 层资产 + 注入就是这个形态。
- Benchmark 数字要带水分读：LongMemEval 91.4% 是**自报**、且按 8,192-token 检索预算测（约为 Zep 90.2% 所用 token 的两倍，每查询真金白银）；其 AMB 博客自报 v0.4.19 为 LoComo 92.0% / LongMemEval 94.6%。**这些数字不构成我们的路线依据**——我们没有评测 harness，也无需对齐它。

## 2. 逐概念映射（ours vs Hindsight vs 缺口）

| Hindsight 机制 | 我们的对应 | 缺口与 v2 草案 | 取/不取 |
|---|---|---|---|
| pages 持续重写 | `core` memory 常驻注入 + `asset/update` + review(update) 审批 | reflect 的输出以 **update 提议**形式进现有审批队列——自动重写不直写团队资产，人裁决 | **取**（这是 v2 的主线形态） |
| observations + proof count | `atom` 层（单条事实）；版本只追加 | 草稿 `source` 留 session_id（O-7 已计划）；信念强度=重复事实多源计数，draft 合并时累加 | **取轻量版**（evidence trail + 计数，不建独立观察表） |
| reflect 回路 | 无 | 输入：近 N 份 session/report + 目标资产清单；输出：新 atom 草稿 + core 资产 update 提议；触发：手动命令起步（`ck reflect --asset <id>`），批处理/定时等通道稳定后再说 | **取**（依赖 O-7 通道；先手动后自动） |
| 矛盾消解 | 人审（review / B.6） | reflect 时做"重复 / 矛盾 / 过时"三分类，各生成对应提议；**不做自动裁决** | **只取检测** |
| temporal 检索臂 | `expires_at` 是衰减不是检索维度 | 无需：团队知识库的查询极少按日期区间 | **不取** |
| graph 链接臂 | — | comparison.md 已拍"不取：图数据库" | **不取**（维持） |
| cross-encoder 重排 | FTS + JS 评分（O-9 后 + RRF） | 排序质量够用再说；属 O-9 后续调参 | **缓** |
| Memory Defense | 共享审批人审 + B.3 自查清单 | 可加规则型预检（正则找 token/密钥形状），共享提交时警告——**零 LLM 可做** | **取**（小件，可提前做，不依赖 O-7） |
| decision model | 无 | 等通道（O-7）落地后再评估 | **缓** |
| bank 硬隔离 | 团队可见性模型 | 与我们核心卖点相反（comparison.md 已拍） | **不取**（维持） |

## 3. v2 草案范围（开工时再细化成实现顺序）

1. **reflect 提议回路**（主线）：`ck reflect`（或 MCP 工具）→ LLM 读近 N 份会话报告 + 目标资产 → 产出「新 atom 草稿（私有）/ core 资产 update 提议（进审批）/ 矛盾提示」三类，全部落现有 draft / review 机制，**零新 schema**（除 evidence trail）。—— **2026-11-16 已落地并实机验证**：`cli/src/reflect.ts`（`ck reflect --asset <id> --url <base> --model <m> [--dry-run]`，env 兜底 `CK_LLM_*`），真 LLM（glm-5.3-flash 经 magpie）产出的提议质量极高——正确区分了「时效信息进 atom 而非长期约定」「合并升级阈值进正文」「报告矛盾但不裁决」。
2. **evidence trail**：draft 的 `source`（session_id + 原文摘要），重复事实合并计数——挂 auto-distill（O-7）第 2 步一起落。
3. **PII / secrets 规则预检**：不依赖 LLM，可独立先做（共享提交时的自动警告）。
4. 其余（temporal 臂、graph、cross-encoder、decision model、bank）：**不做**。

依赖关系：1、2 依赖 O-7 通道拍板（与 auto-distill、O-9 embedding 同一道题）；3 零依赖可随时做。时效失效与 pages 形态**零工程**。

## 3.5 PII / secrets 规则预检（§3 第 3 条的实现口径）

**范围**：`asset/set-visibility`（提升到非 private 时）、`session/report`（每条候选）、`asset/create`（正文）——hub 侧统一扫描，命中**警告不拦截**（裁决权留人审）。响应带 `warnings`（空时键不出现）；审计 detail 记命中 kind 计数、不记正文。规则见 `core/src/pii.ts`（形状正则，零 LLM 零新依赖）。

## 4. 待拍板清单（Yorker，v2 开工前）

1. v2 范围确认：只做 §3 的 1–3，其余明确不做。
2. reflect 产物进团队资产的路径**只能是 update 提议**（人审裁决），是否接受——这是"自动沉淀只落私有草稿"原则向"团队上下文"的延伸适用。
3. PII 预检是否提前做（不依赖 O-7，可以现在立项）。

**2026-11-16 更新：LY 已按 O-43 授权模式确认（「按最优继续拍板」）**——范围按 §3 的 1–3 执行：reflect 产物进团队资产**只走 update 提议**（人审裁决，模型永不全权直写团队上下文）；PII 预检立项（零 LLM 依赖）。同日开工：§3.3 PII 预检先落地（hub 共享提交时的规则型警告，见 §6）；reflect 回路（§3.1）以 `ck reflect` 手动命令起步。

## 5. 来源

- 论文 arXiv:2512.12818（HTML 版全文）；hindsight.vectorize.io（产品页、2026-03 AMB 博客——v0.4.19 自报数字与"评测诚实度"声明）；github.com/vectorize-io/hindsight。
- 第三方：akitaonrails/ai-memory `research-hindsight.md`（2026-09 深度研究笔记——机制核实、"pages-over-facts"独立印证、borrow/avoid 清单）；getzep.com 对比页（token 预算口径 8,192 vs 4,408）。
- 本仓库：[comparison.md](comparison.md) §Hindsight（原始取/不取判断）、§「P3 之后还剩什么」（v2 展望原文）、[data-model.md](data-model.md)（`expires_at` 语义 line 245、layer 表 line 297-306）、[auto-distill.md](auto-distill.md)（evidence trail 的上游）、[vector-search.md](vector-search.md)（检索侧现状与 RRF）。
