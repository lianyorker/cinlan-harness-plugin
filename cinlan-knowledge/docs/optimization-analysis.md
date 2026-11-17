# 优化与缺项分析（2026-11-16，「看看有没有要优化的」）

SOP 走完之后的一次整体盘点。分三类：**能做但没做的**（有明确收益、本地可实现）、**做了但值得加强的**（现有功能的深化）、**刻意不做的**（已拍板）。

## 1. 能做但没做的（按优先级）

### 1.1 🔴 向量检索的冷启动门槛
**问题**：O-9 的语义检索需要三件套——magpie 加 embedding 路由、hub 配 `embedding.dims`、跑 `ck embeddings sync` 回填——任何一个没做，语义路就是死的。  
**能做**：`ck setup` / `ck doctor` 检查「向量检索已启用但未回填」状态；panel `/guide` 的接入指南里加一行提示；`ck embeddings sync` 的 `--dry-run` 已经能看差集规模，但没做 panel 侧的「向量检索就绪状态」显示（现在只能靠 embedding/pending 数量猜）。

### 1.2 🔴 草稿收件箱的提醒缺失
**问题**：沉淀的草稿堆在 `/inbox` 里没人看（B.6 月度治理有「零用量」清单，但没有「草稿堆积」提示）。  
**能做**：panel 首页或顶栏加「收件箱 N 条待处理」徽标；hub 的 `usage/summary` 或 `system/stats` 里加草稿计数；`ck doctor` 的 cache 通报里顺带报草稿数（零成本，一行 SQL）。

### 1.3 🟡 宿主覆盖广度（hosts.md §7 六问）
**现状**：6 个宿主已接入（dsh / cinlan-harness / claude-code / codex / gemini-cli / opencode），但 Cursor / CodeBuddy / WorkBuddy / Pi / OpenClaw 还没动。  
**能做**：按 hosts.md §7 六问逐个 spike——每个半天量级。不需要全会，挑一个最可能的（Cursor 在国内企业环境里份额不小）。

### 1.4 🟡 备份自动化（B.8 已写但没人做）
**现状**：`cinlan-knowledge backup` 存在但没人跑——hub 里没有定时任务，依赖外部 cron/计划任务。  
**能做**：hub 启动时加个可选 `backup.cron` 配置（简单间隔如 `every: 24h`），不引 cron 库，一个 setInterval 就行。面板里加「最近备份时间」显示。

### 1.5 🟡 多 hub 联邦（已在 blueprint 里提过）
**现状**：单 hub 单库，没有跨 hub 的资产同步。  
**能做**：`ck federation sync --from <other-hub-url>`——拉另一个 hub 的公开资产（`visibility=team` 以上），以 import 形式落入本 hub 的 draft 区（人审采纳）。这是企业部署里真正缺的：部门 A 的 hub 和部门 B 的 hub 之间没有共享通道。

### 1.6 🟡 Skill 版本管理面板化
**现状**：skill 的版本历史在 API 里有（`asset/history`），但面板里没有「版本对比」视图——e2e 测试里有 `VersionDiff`，但页面入口藏在详情抽屉里。  
**能做**：panel 详情抽屉的版本历史已有 diff 功能，但入口不明显；可以在 `/assets` 列表加一列「最近变更」，点击直接跳 diff。

### 1.7 🟢 Agent 健康检查
**现状**：Agent 的状态只有 active/archived，没有「上次活跃时间」的告警。  
**能做**：`usage/summary` 加 `agents_stale_30d`（30 天没出现的 Agent）；panel `/agents` 列表加「超过 30 天未见」标记。

## 2. 做了但值得加强的

### 2.1 向量检索的召回质量
- **现状**：整条资产一个向量（256 KiB 上限），cosine KNN。
- **可加强**：wiki/codegraph 这类大文档的分块（阶段二，vector-search.md 已留位）；中英文混合查询时 embedding 模型本身的语言偏差（bge-m3 中文比 text-embedding-3 好得多）——这个等 magpie 加了 embedding 路由后实测。

### 2.2 审批流的智能化
- **现状**：纯人工审，PII 预检只是警告。
- **可加强**：审批时附带「这条共享的风险评分」（PII 命中数 + 内容敏感度 + 与现有资产的重合度）——用现有 FTS 检索做相似度检测，零新依赖。

### 2.3 reflect 回路的批处理
- **现状**：`ck reflect` 是手动命令，单资产。
- **可加强**：`ck reflect --team <slug>`——对团队里全部活跃资产跑一次，按「草稿多的优先」排序产出。这是 reflect 真正发挥价值的地方（不是单点优化，是批量治理）。

### 2.4 e2e-gate 的断言覆盖
- **现状**：B.1–B.6 + S.1–S.3 覆盖了面板主链路，但没覆盖：受限资产的 ACL 权限流转、多 Agent 共享同一 skill 目录、预算降级（超过 budget_chars 时的行为）。
- **可加强**：每加一个断言就多加一分信心——e2e-gate 现在是 15 个断言，扩到 25 个左右就覆盖了大部分边缘。

## 3. 刻意不做的（已拍板，不动）

| 项 | 决策 |
|---|---|
| A2 原生插件 / A3 Proxy | O-8：只有 A1/A0 覆盖不了的宿主才做 |
| 图数据库（graph 臂） | comparison.md：不取 |
| cross-encoder 重排 | 缓——FTS + RRF 够用 |
| 决策小模型 | 缓——等 O-7 通道稳定 |
| bank 硬隔离 | 与我们的团队可见性模型相反 |
| 企业级能力（SSO/HA/配额） | 接企业前重审，现在刻意不做 |
| Wiki 的 [[双链]] / 目录树 | P4-1 第一版纯长文，Workshop 观察驱动 |
| codegraph 图谱构建器 | 出线，外部工具产出 |

## 4. 建议的下一步

按「最小成本最大收益」排序：

1. **O-9 实机冒烟**（你在 magpie 加 embedding 路由后 `ck embeddings sync` + 语义检索一轮）——现有代码全部就绪，就差一个模型端点
2. **收件箱徽标**（panel 顶栏草稿计数，半天量）
3. **备份自动化**（hub config 加 `backup.interval`，panel 显示最近备份时间，半天量）
4. **e2e-gate 断言扩到 25**（把边缘场景补进来，持续保障）

这四件做完，项目就真的进入「部署驱动迭代」阶段了——剩下的全靠真实使用反馈来调。

## 5. 开源生态对照（2026-11-16，子代理调研）

**生态已收敛到 MCP**——Wiki.js v3 内置 MCP server、Outline 内置、Hindsight 自带。我们的 6 套宿主适配是现状最优（轻量），但长期要收敛到「MCP 为主、宿主适配只做 hook 注入和 skill 物化」。

**Hindsight 的最新状态（2026-11）**：
- 后台巩固：原始事实折叠成带 proof count 的 observations，读取是纯 DB 读（不每次跑 LLM）——我们的 evidence trail 已是这个方向的轻量版
- 专用小模型（决策/重排/嵌入）+ 记忆投毒五层防御（provenance 打标、隔离区、审计 webhook HMAC 签名）
- LongMemEval 94.6%（自报，8,192 token 预算）

**我们没有但值得做的**（优先级排序，全部落在现有架构内）：

| # | 功能 | 收益 | 成本 |
|---|---|---|---|
| 1 | **版本化 + diff + 回滚**（已在 sdk 有 history，缺 panel 视图入口和「回滚到版本」动作） | 审批门防入口防不住错案，没有回滚错误知识永久污染 | 低（版本历史已有，只差回滚动作） |
| 2 | **事实时效/失效**（Zep 式 valid/invalid_at；我们已有 `expires_at` 衰减，缺「自动失效」提示） | 团队知识最值钱的是「当前为真」，不标时效的旧事实会静默撒谎 | 低（panel 列表加「即将过期」标记 + B.6 治理提示） |
| 3 | **Secrets 检测补 PII 预检**（Presidio 社区共识：PII 工具不抓 API key/token） | 沉淀自动化场景 secrets 泄露概率比 PII 更高 | 低（现有 pii.ts 补 Gitleaks 风格正则即可） |
| 4 | **实体抽取与链接**（Mem0 式轻量版：写入时一次 LLM 调用顺带抽实体） | 检索加成显著，远低于建 KG 的成本 | 中（等 O-7 通道稳定后做） |
| 5 | **Provenance 打标 + 来源信任分参与重排** | 投毒防御的核心层（每条知识带谁写入/哪个 session/信任分） | 中（source 已有 session_id，只差检索时参与排序） |
| 6 | **Cross-encoder 重排**（RRF 之后） | Hindsight/Mem0 都靠它把准确率顶上去，RRF 只融合不重排是精度天花板 | 中（等小模型端点，缓） |
| 7 | **报告合成管线**（STORM 式：大纲→人审→分节生成） | 复用现有审批门即可长出「深度研究」能力，reflect 回路的自然延伸 | 高（等真实使用有需求再做） |
| 8 | **程序化记忆**（Agent 自改行为规则，沉淀「什么该做」） | LangMem 证明价值，且能走同一审批门 | 高（v2+ 再评估） |
| 9 | **MCP server 收敛**（替代 6 套宿主适配的维护成本） | 长期负资产→战略收敛 | 高（等 MCP 生态更成熟再动） |
| 10 | **评测基准管线**（LongMemEval/LoCoMo 子集） | 证明我们的 RRF 改动是改进还是退化，没有 eval 就无法证明质量 | 中（等真实部署后做） |

**生态判断**：我们比所有开源同行多了一个核心差异化——**共享审批门 + 权限治理**（Outline/Wiki.js 是文档协作、Mem0/Zep 是记忆引擎、Hindsight 是记忆智能，没有人做「团队知识进 Agent 上下文前的审批+审计+权限」）。这是我们的护城河，继续深耕。
