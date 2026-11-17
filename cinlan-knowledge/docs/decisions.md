# 决策记录

## 1. 方向变更（2026-11-12）

早期文档把 cinlan-knowledge 定义为"cinlan-knowledge-sync 的分层重组"：条目同步 + 每次写入审批 + scope 授权 + JSON 文件。现改为**照腾讯 Memory Hub 的模型重做**：统一记忆资产 + 可见性 / ACL + Team / User / Agent + 配装。demo 的代码与旧文档不再是约束，只提供教训（§4）。

第二轮修订（同日）：**多宿主是一等目标**。

`[Corrected]` 前一轮的结论"dsh 是自家 harness，所以 P1 直接做进程内插件"是错的；根因是未经验证就假定了 dsh 的所有权。dsh 是 DeepSeek Harness，只是一个宿主。团队里还会有 Claude Code、Codex CLI、Gemini CLI 等。运行面主通道因此改为 **MCP + `ck`**，宿主适配退化为配置声明（D-08、D-17、D-19）。这一改动波及 [architecture.md](architecture.md) §5、[hosts.md](hosts.md) 全文、[loadout.md](loadout.md) §4 / §6 / §7。

被推翻的旧定案：

| 旧定案 | 现定案 |
| --- | --- |
| markdown / JSON 文件即事实源，不上 SQLite | SQLite 单文件是事实源（D-02） |
| 写入必过审 | 默认 private 免审，提升可见性才过审（D-05） |
| scope 字符串 + 通配授权 | Team 成员关系 + 可见性 + ACL（D-03、D-04） |
| 不做 team / agent / asset 控制台，只取审批域 | 资产库、配装、团队、访问控制、用量都做（P2） |
| 单 adminToken，不做多用户 | System Admin / Team Admin / Member / Owner（D-03） |
| 节点 push / pull 同步引擎 + `shared/` 缓存 | 无同步；客户端取配装结果（D-01、D-07） |
| P1 做 dsh 进程内插件 | P1 做 MCP 面 + `ck` + 两个参考宿主；原生插件降为 P3 可选（D-08） |

对旧文档里事实错误的更正：

- 旧 decisions 写的 `baseVersion` 修法"恒为 `rec?.seq`"是错的：hub 比较的是 `existing.version`，发 `seq` 永远对不上。新设计里只有 `base_version` 对 `current_version` 一种比较，`seq` 不出现在客户端契约里。
- 旧 comparison 把腾讯的检索写成"LLM 召回"、分发面写成"REST"。其 README 写的是 BM25 + 向量 + RRF；分发面有 REST、MCP（MemoryKnowledge）、Proxy、SDK。已在新 comparison 改正。
- 早期文档的接入等级编号 L0–L3 与腾讯的记忆分层 L0–L3 撞名。改为 A0–A3（A = Adapter）。

## 2. 定案

| 编号 | 定案 | 备选 | 取它的理由 |
| --- | --- | --- | --- |
| D-01 | 资产注册表取代条目同步；hub 是唯一事实源 | 保留本地文件双向同步 | 同步引擎是 demo 大半缺陷的来源（§4）；"读档"需要的是服务端按身份算出来的结果，不是文件镜像 |
| D-02 | 存储用 `node:sqlite` 单文件 | JSON 文件；better-sqlite3；Postgres | 有了用户、团队、ACL、绑定、版本、用量，关系查询是刚需；内置模块零依赖；备份是一个文件。风险：仍带 Experimental 警告 → 全部收在 `db.ts`，可换驱动 |
| D-03 | 身份 = User Key；角色 = System Admin / Team Admin / Member；Owner 自管 | 节点 token + scope | 照腾讯；授权对象是人和 Agent，不是机器 |
| D-04 | 可见性四档，新资产恒为 private | 默认 team | 照腾讯；默认私有才敢让模型自由写 |
| D-05 | 审批门挪到"提升可见性"和"他人提议修改"；`review_mode` 默认 `share`，Admin 可自批 | 每次写入都审；完全不审 | 保住 demo 的治理价值，去掉单人自用时的审批疲劳；team 可见内容会进所有成员 Agent 的上下文，这一步值得一道门。对安全敏感的团队可调成 `all`（管理者的修改也过审） |
| D-06 | 配装 = 一张绑定表；模板拷贝到新 Agent，更新靠显式 `loadout/sync-template` | 运行期继承（团队层 + Agent 层叠加） | 照腾讯的"拷贝"；一张表可预期、可预览，下发动作可审计 |
| D-07 | 注入计划在 hub 生成（文本 + digest），客户端只投递 | 客户端拼装 | 所有通道（hook / `instructions` / 工具 / 以后的 Proxy）行为一致；预算、排序、降级只实现一次 |
| D-08 | **MCP 是 P1 运行面主通道**：hub 出 `/mcp`，客户端用 `ck` 提供 stdio MCP + 会话开始 hook；宿主侧只是配置条目。原生插件（A2）与 Proxy（A3）都是 P3 可选 | 每个宿主写一套插件；照腾讯全面走 Proxy | dsh 是 DeepSeek Harness，不是自家 harness，宿主数量不可控。MCP + hook + 原生 skill 目录是各宿主的公共交集，一套实现覆盖全部。Proxy 要实现协议直通、SSE、代理内工具循环，且成为全部 LLM 流量与模型密钥的单点（腾讯为此每接一个客户端要 3–4 个工作日） |
| D-09 | `atom` 记忆按需工具检索，不逐轮自动注入 | 每轮按用户消息召回并注入 | 照腾讯 Proxy 的注入策略（L1 走工具，避免破坏上游 KV cache）；注入只在会话开始做一次 |
| D-10 | 预算用字符数 | token 估算 | 确定、可测；腾讯的封顶项也是条数、字符预算、超时 |
| D-11 | 全 POST RPC + 统一信封 + 大写错误枚举 | REST 资源路由 | 照腾讯面板 API；路由退化成查表，hub 不需要框架 |
| D-12 | 检索 = FTS5 trigram，少于 3 字符的词 LIKE 兜底；向量后置 | 一开始就上向量 | 本机实测 trigram 对中英文可用、2 字中文词需兜底；向量要新依赖与 embedding 通道 |
| D-13 | skill 平铺物化到**宿主自己的用户级 skill 目录** + 标记文件 | 按团队 / 层级嵌套；物化到自定义目录 | 宿主只下探一层，且各家发现根不同：dsh / Codex / Gemini 用 `~/.agents/skills/`，Claude Code 用 `~/.claude/skills/`。用宿主自己的根才能吃到热加载，不必改宿主的 skill 配置 |
| D-14 | id 一律服务端生成，不取自标题或文件名 | 标题转 slug | 消除中文 id 与白名单冲突、路径穿越 |
| D-15 | hub 自身代码零第三方运行时依赖（`node:http` + `node:sqlite`）；唯一例外是 `packages/mcp` 引官方 MCP server SDK | Hono + zod；自己手写 MCP 协议 | 动作约 50 个，查表 + 手写校验足够。但 MCP 协议已到 2026-07-28 版本，手写 JSON-RPC + 传输层是在维护协议实现，得不偿失；SDK 只关在一个包里 |
| D-16 | 单进程单端口：API + `/mcp` + panel + `/dl` | 腾讯式多服务多端口 | 团队规模用不上拆分；无跨域；`ck` 的分发包由同一个服务出，版本天然配套 |
| D-17 | 三种基线投递方式（hook / `instructions` / `tool`），文本同源（`loadout/resolve`）；每个宿主只启用一种完整投递，`brief` 可与 hook 共存 | 每宿主各写一套注入逻辑 | 文本与预算只在 hub 算一次；宿主差异变成数据（`agents/<host>/host.json`） |
| D-18 | MCP 面用官方 server SDK，工具定义只写一次，对 `Rpc` 接口编程 | 手写协议；只为 hub 实现 | hub 的 `/mcp` 与 `ck mcp` 共用同一份工具定义，A0 与 A1 的契约必然一致 |
| D-19 | `ck` 是宿主侧唯一可执行文件（Node ≥ 20，自包含 tarball，由 hub 的 `/dl` 分发） | 每宿主一个二进制；让用户自己 clone 仓库 | 一份代码覆盖全部宿主；升级只换一个包；key 与缓存集中在一处管理 |
| D-20 | 默认 A1（stdio + hook）；远端 `/mcp`（A0）作为零安装兜底 | 默认直连远端 | A1 下 key 不进宿主配置、有 skill 物化、不吃宿主的 `instructions` 长度限制；A0 用于装不了 `ck` 的场景 |
| D-21 | `asset` 显式整数主键 `seq`，FTS 的 `rowid` 指向它；`id TEXT UNIQUE` 只作对外标识 | 用隐式 rowid 做 FTS 关联 | SQLite 文档不保证 `VACUUM` 后隐式 rowid 不变（本机实测保存了，但不能依赖）；备份恢复后检索错位是最难查的一类 bug |
| D-22 | 本机资产导入（P2）只导 skill；落成调用者的 private 资产 | 导记忆；导成团队资产 | 记忆是对话产物，脱离上下文导入意义不大；skill 是文件，边界清晰。导入恒为 private，要共享仍走审批 |
| D-23 | 预算分两层：字符数 `budget_chars`（默认 12,000）+ 字节数 `max_bytes`（A1 下按宿主声明，dsh 24,000）；Claude Code 的 hook 预算 8,000 字符；`brief` ≤ 1,500 字符 | 只按字符；只按 token | dsh 的 `instructions` 上限是 32,768 UTF-8 字节，全中文下字符数与字节数差 3 倍；Claude Code 的 hook 输出超 10,000 字符会被改存文件，注入失效。两者都必须按宿主分开定 |
| D-24 | skill 名字的唯一性按 `(team, type, owner, name)` 计；提升可见性时在同一事务里校验团队内同类资产不重名 | 团队内全局唯一 | 多人各自导入同名私有 skill 是常态；团队级唯一会让第二个人连私有保存都失败，还会泄露"这个名字已被别人占用" |

## 3. 取自腾讯的清单

| 腾讯的做法 | 取舍 | 说明 |
| --- | --- | --- |
| 统一记忆资产：Chat Memory / Skill / Wiki / CodeGraph，带 Owner、版本、状态、可见性、用量、Agent 绑定 | 取 | P1 做 memory + skill |
| 可见性 `private / team / restricted / agent` | 取 | set-visibility 里的 `task` 不取 |
| 角色：System Admin、团队 Admin / Member，Owner 自管 | 取 | |
| 新 Chat Memory / Skill 默认 private，共享是显式动作 | 取 | 并在共享上加审批（D-05） |
| Agent Loadout = Fixed Binding + ACL；绑定带优先级与使用方式 | 取 | `priority` + `injection_mode` |
| 团队默认 Agent 模板，拷贝给新成员的默认 Agent | 取 | 另加显式下发 |
| L0–L3 分层 | 取语义 | `layer` 字段；自动抽取放 P3 |
| 检索 BM25 + 向量 + RRF；按条数、字符预算、超时封顶 | 部分取 | P1：BM25 + 封顶（条数、字符、字节）；向量与 RRF 在 P3 |
| Proxy 流水线（auth → sessionInit → injection → rateLimit → forward → extract → report）与注入策略 | 只取策略 | 注入时机与会话级快照取；Proxy 本体不取（D-08） |
| 面板 API 约定：全 POST、信封、大写错误枚举 | 取 | |
| meta 动作集：user / user-key / team / team-member / agent / asset / acl / auth | 取子集 | task、task-agent、participation-log、instance-quota 不取 |
| 六个玩法：Team Up / Asset Library / Agent Loadout / Knowledge Workshop / Access Control / Asset Usage Analytics | 取五个 | Knowledge Workshop 在 P4 |
| 一体化镜像（Panel 8125 + KS 8424 同容器） | 取形态 | 我们单端口 |
| `agents/<宿主>` 每端一份接入（含 setup 脚本与 asset-import） | 取形态 | 我们每端一份 `host.json` + 模板 + 手册；统一由 `ck setup` 落地 |
| MemoryKnowledge 对外暴露 MCP（`/v3/tools/list` + `/v3/tools/call`） | 取思路，升级形态 | 直接用标准 MCP（Streamable HTTP），不走私有工具 RPC；工具集仍是同一套 |
| MemoryKnowledge（Wiki + CodeGraph） | P4 | |
| chat-memory 借用（allocate，上限 2） | 不取 | 没有对应需求 |
| 多实例与配额（`meta/instances`、instance-quota） | 不取 | 单 hub |
| Python SDK | 不取 | |

## 4. demo 教训 → 新设计如何处理

| demo 里的问题 | 处理 |
| --- | --- |
| 含中文的记忆 id 过不了 ASCII 白名单；`entry.id` 裸拼文件名有穿越风险 | D-14：id 服务端生成；只有 skill 的 `name` 是 slug 且入库校验 |
| `baseVersion` 发的是 `seq`，hub 比的是 `version` | 只有 `base_version` 对 `current_version` |
| tombstone 与同 id 重新发布在一次 pull 里顺序错乱 | D-01：没有同步，没有 tombstone |
| store 无写互斥，同一条可被批准两次；多文件批准非原子 | 不变量 7：一个动作一个同步事务；审批用条件更新 |
| hub 不复算 hash；`/admin/integrity` 的 hash 输入与节点侧不一致，几乎每条都报不一致 | `content_hash` 只由 hub 用同一个函数算 |
| 未知错误码一律 400 | 枚举穷举，未知 = 500 `INTERNAL` |
| 过期条目仍出现在检索里 | 过期条件写在 `accessibleSql` 一处 |
| admin token 调节点端点落到 `node = undefined` | 只有一种 principal；每个动作声明所需角色与是否需要 Agent |
| token 摘要用 `===` 比较 | 前缀查表 + `timingSafeEqual` |
| `/healthz` 泄露库存统计 | `/healthz` 只回 `{ ok }` |
| 拉到嵌套 scope 目录的 skill 不被 harness 发现 | D-13：平铺物化，且落到宿主自己的 skill 根 |
| 节点配置无 `${ENV}`；Desktop 上 `!!js process.env.X` 不可靠 | `ck` 只管本机配置；`CK_HUB_URL` / `CK_USER_KEY` 优先于文件 |
| `file:` 安装是拷贝，改源码要重装 | `ck` 走自包含 tarball；宿主配置里的条目只指向 `ck` 的一个绝对路径（D-19） |
| 拉到 `shared/` 没人用 | 配装注入 + 工具 + skill 物化 |
| 单人自用时每条都要自己批 | D-05：private 免审；Admin 可自批 |
| 只能服务一种宿主（写死 dsh 的插件接口） | D-08：运行面只依赖 MCP / hook / skill 目录 |

## 5. 待 Yorker 拍板（不拍板则按默认实现）

已定（Yorker 第二轮答复）：

| 编号 | 事项 | 结论 |
| --- | --- | --- |
| O-1 | hub 的 Node 下限 | 按推荐：**24**（`node:sqlite` + FTS5 trigram 本机 v24.9.0 实测）。`ck` 侧仍只要求 Node ≥ 20 |
| O-2 | panel 依赖清单：`react`、`react-dom`、`vite`、`typescript`、`diff`；是否跟腾讯的 Tailwind 与 Zustand | 按推荐：**只引这五个**；样式跟现有设计系统，状态用 React 自带 |
| O-3 | `review_mode` 与 `allow_self_approve` 的默认值 | 按推荐：`share` + 允许自批；对安全敏感的团队可调 `all` |

默认实现（Yorker 授权按判断决定）：

| 编号 | 事项 | 默认 |
| --- | --- | --- |
| O-4 | System Admin 能否读他人 private 正文 | 不能，只有元数据与强制归档 |
| O-5 | demo 已发布数据是否导入 | 不导入；`asset/import` 只服务本机已有 skill（D-22） |
| O-6 | 端口与工具前缀 | 沿用 8424 与 `knowledge_*`；MCP server 名 `ck` |
| O-7 | P3 自动沉淀用哪个模型通道（hub 侧 LLM 绑定） | **已拍（2026-11-16，LY 授权按最优拍板，O-43）**：通道取 **A' 客户端抽取**——模型调用发生在宿主机侧（ck / MCP 入口），hub 保持零 LLM（"不代理 LLM 流量"原则不动摇），`session/report` 直接送结构化候选、hub 逐条落 `status=draft` 私有草稿；触发取**模型自报为主（新 MCP 工具）+ 手动保底（CLI）**，hook 会话尾事件因宿主事件面参差不做统一。规格与实现顺序见 [auto-distill.md](auto-distill.md)，B'/C' 作为记录保留 |
| O-8 | P3 是否做 Proxy 与向量检索、是否做原生插件 | 都不做；只有出现 A1 / A0 覆盖不了的宿主（按 [hosts.md](hosts.md) §7 的六个问题判定）才做 A2 / A3 |
| O-9 | P3 存储与向量检索的分档方案 | **2026-11-16 研究后按最优修订拍板（LY 授权，O-43），原文缩减**：~~两套都实现，seam 适配~~→SQLite 单实现 + **sqlite-vec（v0.1.9）**向量档；Postgres/pgvector 双实现降为**远期可选**（实测 `Db = DatabaseSync` 贯穿全链路、零抽象层，双实现的成本是实打实的而千级向量规模收益为零）；~~SQLite→Postgres 迁移工具是本项范围~~→改为**导出/导入 JSON 快照**（真出现多实例/大库需求再立 PG 规格）。其余按研究建议：embedding 通道取 **A 外置 worker**（hub 零 LLM，与 O-7 同一原则）、阶段一**整条资产一个向量**不分块、RRF k=60 + KNN overfetch 4×、embedding 缺失自动退化纯 FTS。可行性本机实测过（Windows + Node 24.9 + node:sqlite + v0.1.9，vec0/落盘重开/CAST 坑），详见 [vector-search.md](vector-search.md)——本文档即当初"开工前先研究验证"要求的交付物。原方向行存档：主库做 SQLite 与 Postgres 两个驱动（同 `db.ts` 隔离手法），向量做 `sqlite-vec` 与 `pgvector` 两实现；部署档只切配置、不切代码——该方向保留为 PG 档远期落地时的参考 |
| O-10 | 过期语义与 `acl/list` 权限口径（P1 step5 实现冲突，已拍 A） | 过期只挂 `RESOLVE_WHERE_SQL`（检索 / 配装不可见），不进 `canRead`——Owner 可读可续期；`acl/list` 放宽为有 `read` 权限即可列。stale 裁决后 `proposed` 版本行保留编号不落库；同资产同类 `pending` 只留最新，旧置 `withdrawn` |
| O-11 | 宿主覆盖范围（2026-11-12 拍） | P1 参考宿主三个：dsh + **cinlan-harness** + Claude Code（cinlan-harness 复用 dsh 机制，模板变体，成本≈0，且自家源码在手将来升 A2 最便宜）。P2：Codex、Gemini CLI、OpenCode（先 spike）、Hermes（先调研再排档）。CodeBuddy / WorkBuddy / OpenClaw / Pi / Cursor 暂不排期，按需走 [hosts.md](hosts.md) §7 六问 |
| O-12 | panel UI 组件库（2026-11-12 拍） | **保留 React，用 TDesign React**——腾讯自家设计系统，「参考腾讯管理后台」的观感最贴近；备选 antd（生态更大）。element-plus 是 Vue 栈，弃用。O-2 的依赖清单在 P2 开工时补加 `tdesign-react`（及其图标包）；组件库之外仍按 O-2 只引必要依赖 |
| O-13 | `agents/` 随 `ck` 产物的分发方式（2026-11-13 拍 A） | 构建时把 `agents/` 拷进 `packages/cli/agents/` 并加进 `files`——产物自包含、改动小；不做独立 workspace 包（B），也不在 P1 用「文档级等价」搪塞（C）。`hosts.md` §6「整个 agents/ 打进 ck 产物」按此落实 |
| O-14 | P1 验收两处文档冲突（2026-11-13 拍） | ① T7 `system/integrity` 挪 P2——`api.md` 与 A.3 补件清单本就把 `system/*` 排在 P2，P1 T 表收回到 T8/T13 为止。② `data-model.md` §3 以 `canRead`/`canManage` 规则为准修矩阵：`canRead` 补 `canManage ⇒ canRead`（Admin 对 restricted 资产此前"能管不能读"是代码缺漏，实现要补）；矩阵「团队外 / agent」列改为「绑定即授权，不限成员身份」 |

已定（Yorker 第三轮答复）：

| 编号 | 事项 | 结论 |
| --- | --- | --- |
| N-1 | `@modelcontextprotocol/server`（2.x，会带入 `core`、`zod`） | **采用官方 SDK**，作 `packages/mcp` 的运行时依赖；不手写 JSON-RPC 与传输层（D-18） |
| N-2 | `@modelcontextprotocol/client` | **采用官方 SDK**，作测试 devDependency；T10 用官方 client 验契约 |
| N-3 | `@modelcontextprotocol/node` | 仍为兜底：仅当 S1 发现 SDK 传输层挂不上 `node:http` 才加；S1 通过则不加 |

待拍（2026-11-13，P2 后端补件；文档没写到的地方先按下表实现，Yorker 尚未过目）：

| 编号 | 事项 | 当前实现 |
| --- | --- | --- |
| O-15 | 按 key 限流的额度与口径（`api.md` 只写了 429 + `Retry-After`，没给数字） | 固定窗口，每把 key 每 60 秒 600 次；`knowledge.config.json` 可用 `limits.rateLimit: { windowSeconds, maxRequests }` 覆盖（`install.md` §1 的示例还没加这一项，拍板后补）。计数点在认证通过之后、读正文之前，`/api/v1/*` 与 `/mcp` 共用一份额度，一次 HTTP POST 记一次。认不出 key 的请求、未知动作、`/healthz`、`/dl/*` 不计也不受限。计数只在 hub 进程内存里，重启清零。429 的信封里多带一个 `data.retry_after`，与 `Retry-After` 头是同一个秒数。客户端侧没动：`ck hook` / `ck mcp` 读档遇到 429 仍按「hub 不可达」回落缓存（[acceptance-report.md](acceptance-report.md) §6.7） |
| O-16 | `audit/list` 里 Team Admin 能看到哪些行（`audit` 表没有团队列） | 按目标反查：目标是本团队的 asset / agent / review / team 才算本团队。目标是 `user`、`user-key` 的行和没有目标的系统动作只有 SA 看得到；资产 purge 之后，它留下的审计行 TA 也看不到了 |
| O-17 | `system/integrity` 对历史版本的口径（标签只存在资产行上，不随版本留底） | 版本分三类计数：`verified` / `unverifiable` / `mismatched`。改过标签之后，更早的版本算不回原 hash，记 `unverifiable`，不报不一致；现行版本必须分毫不差。要让全部版本都可复算，需要加一次迁移，把 tags / layer / expires_at 随版本留底 |
| O-18 | `asset/import` 带 `on_conflict: "new_version"`，而这次修改按团队审批模式要过审批（资产已共享且 `review_mode = all`） | 不代发审批单：回 `conflict`，资产不动。`api.md` 给的结果只有四种；要让它像 `asset/update` 那样回 `pending_review`，得加第五种 |
| O-19 | `asset/import` 的入参与比对口径 | 入参是本机目录的整份快照：`host`、`import_path` 平铺在顶层；没给的 `summary` / `tags` / `files` 按空算，所以库里有而本机没有也算「内容不同」。出新版本时不改资产的 `source`，版本的 `change_note` 记 `imported from <host>`。四种结果每次都留一条审计，`detail` 只有 `status` / `host` / `version` |
| O-20 | 备份落点的三处写法不一致（**冲突，未改**） | `install.md` §4 是 `backup --config <cfg> [--out <dir>]`、落 `dataDir/backups/`；`sop.md` B.8 是 `--out /abs/backups/knowledge-<日期>.db`；`hub/src/bin.ts` 现在是必填的 `--out <file>`。新做的 `system/backup` 动作跟 `install.md`：落 `<dataDir>/backups/knowledge-<UTC 时间戳>.db`，请求体不收路径。CLI 与两份文档没动 |
| O-21 | `system/*` 的三处已知限制 | `system/backup` 的审计行在备份完成后单独写，不与备份同一个事务（`VACUUM` 不能在事务里跑）；`system/integrity` 不查没有归属版本的 `asset_file` 行；`PRAGMA integrity_check` 在请求线程里同步跑，库大了会卡住其他请求 |
| O-22 | `packages/panel` 在 O-2 + O-12 的依赖之外还需要 `@types/react`、`@types/react-dom`（类型声明，devDependency，不进产物） | 已加进 `packages/panel/package.json`：`react` / `react-dom` 自身不带类型，不装则 `tsc -p tsconfig.json` 直接失败。回退办法是删这两行、自己写一份最小 JSX 声明，但那样 TDesign 的组件类型也拿不到，不值得 |
| O-23 | panel 的样式组织（`panel-design.md` §8 写「每页一个 CSS Module」，没写共享壳怎么拆） | 实际是一份全局 `packages/panel/src/styles.css`（`ck-*` 语义类 + `:root` 令牌），八页共用。原因：壳 / 表格 / 状态块 / 详情栅格全部跨页复用，CSS Module 要么重复声明要么逼出更重的抽象。已登记在 `panel-design.md` §8「落地记录」，等 Yorker 重审 |
| O-24 | `/audit` 的 detail 悬浮层与时间筛选在 TDesign 1.18.6 里没有对应组件 | `Popover` 不存在（导出的是 `Popup` / `Popconfirm`），`Input` 的 `type` 联合也没有 `datetime-local`。细节用 `Popup` 承载 `<pre class="ck-code ck-code-detail">`，两个时间框用原生 `<input type="datetime-local" class="ck-input">`，视觉按既有令牌对齐，不引新组件 |
| O-25 | panel 的路由实现（`panel-design.md` §3 只说「最小路由」，没写形态） | `lib/router.ts` 自实现：`BASE = "/panel"`，`parseRoute` 解析 `pathname + search`，`useNavigate` 走 `history.pushState` + 手动派发 `popstate`；详情页 `agents/:id`、`teams/:id` 支持深链。没引 react-router |
| O-26 | 已登录状态下访问 `/panel/login` 的行为（文档未写） | `App` 里做重定向：有会话且路由是 `login` 时 `useEffect` 跳 `/panel/assets`；首次渲染分母保持 `AssetsPage`，避免闪一帧登录表单。同时 sessionStorage 里 key 失效（401）→ `session.clear()` + 登录页提示 |
| O-27 | `ck import` 的团队入口（`asset/import` 必填 team，hosts.md §5 原 flag 行没有） | **已拍板（C+A，2026-11-13）**：`auth/verify` 的团队列表唯一时自动选；多个团队报错列出并要求 `--team <slug>` 显式指定；`--team` 给非成员团队直接拒绝。`--team` flag 已补进 hosts.md §5 §8 |
| O-28 | `ck import` 的其余默认口径（文档没写到的实现细节） | `title` 暂用 frontmatter `name`（`description` 只进 `summary`）；`summary` 超 300 截断而非报错；逐条提交网络错误 / 429 共尝试 3 次（两次重试前退避 1s / 2s，取 `data.retry_after` 与退避的较大值）；新增 `--dry-run` flag（只列候选不写）；非 TTY 且没 `--yes` 直接拒绝不写；`import_scan` 的 `$VAR` 未设置或目录不存在记 note 跳过；交互选择接受 `1,3,5-7` 序号与区间。**2026-11-14 走查补充（新增默认，等重审）**：`import_scan` 同时展开 `%VAR%`（hermes 的 win32 声明 `%LOCALAPPDATA%/hermes/skills`，未设置同样记 note 跳过）；条目之间固定间隔 100ms（hosts.md §8「限速」的落地值）；重试用尽按原错误码记失败（429 记 `RATE_LIMITED`，网络错误记 `UNAVAILABLE`）；失败原因带 hub 的 `data.issues`，错误码只在状态位出现一次；客户端 frontmatter 读法与 core `parseSkillFrontmatter` 对齐（空 `description:` 在扫描时就跳过，不再送上去被拒）。**已拍（2026-11-14）**：① 合计口径——扫描期跳过的目录（坏 frontmatter / 重名 / 已物化 / 读失败）与交互里没选中的候选都计入 `skipped`，`total` 是扫到的全部 skill 目录数（data-model.md §9）；② 重试次数以实现为准，本行原文「共重试 3 次（退避 1s / 2s / 4s）」已改成「共尝试 3 次」；③ 资产名取 frontmatter `name`、目录名不参与（hub 要求 frontmatter `name` 等于 `asset.name`），两者不同的目录按 frontmatter 的名字登记；④ 扫描位置以 `host.json` 的 `import_scan` 为准，hosts.md §8 的表按声明重写（补 cinlan-harness / hermes / opencode），codex「从 git 根逐级找 `.agents/skills`」与 dsh `customSkillDirs` 两处声明表达不了的，记为已知缺口不实现；⑤ frontmatter 的块标量（`description: >-` / `>` / `|`）core 与 cli 两份解析器都认，`>` 折叠、`|` 保留换行，空块等同缺 `description`（此前读成字面量 `>-`，摘要就是这两个字符）；⑥ 断点续跑认 hub 幂等（重跑时已导入的返回 `unchanged`），本机不留进度文件——对「批处理至少把已完成项记到文件」这条通用纪律的有意偏离，理由是进度文件只能省掉重复请求，省不掉 hub 侧的判重，而且多一份会过期的本机状态 |
| O-29 | `agents/codex` 的实现口径（spike 后拍） | A1 stdio + hook。`instructions` 用 `brief`（codex 不作指令级采用，放 brief 无害且保 metadata 最小）；matcher `startup\|clear\|compact`，排除 `resume`/`fork`（历史里已有 baseline）；hook 条目显式 `timeout: 15` 使 `trusted_hash` 可预算；`ck setup` 往 config.toml 的标记块里同时写 `[mcp_servers.ck]` 与 `[hooks.state.*]` 信任表（sha256 算法按 `command_hook_hash` 复刻，实机验证可免 `/hooks` 审查）；`features.hooks` 不写（`[features]` 重复定义会炸用户配置），留 `codex features enable hooks` 人工一步并在 plan detail 里提示。**已拍（2026-11-14）**：远端条目的密钥变量名统一成 `CK_USER_KEY`（原模板与 `setup.ts` 写的是 `CK_KEY`，与 ck 自己读的、各文档写的不同名）；真 codex 0.166.0 对临时 `CODEX_HOME` 读回 `bearer_token_env_var: CK_USER_KEY` |
| O-30 | `agents/gemini-cli` 的实现口径（0.68.0 bundle spike 后拍） | A1 stdio + hook。`mcpServers.ck` 与 `hooks.SessionStart` 同住 `~/.gemini/settings.json`——`ck setup` 对同文件做**单次合并规划**（两份独立 FileChange 会互相覆盖）；条目 `trust: true`（可信工作区免逐次 MCP 确认）；hook matcher `startup\|resume\|clear`（gemini 的 SessionStart 没有 compact，压缩走独立 `PreCompress`，resume 也注入以兜住清空/恢复后无 baseline 的情形）；`timeout: 15000`（gemini 是**毫秒**，与 codex 秒制区分字段 `timeout_ms`）；`name: "cinlan-knowledge"`（`disabledHooks` 的禁用键与显示名）；不写 `enableHooks`（缺省即 true）、用户级配置无信任门槛；skill 落 `~/.agents/skills` 共享池（gemini 与 `~/.gemini/skills` 双扫） |
| O-31 | `ck setup --write` 遇到冲突时写不写其他文件（[acceptance-report.md](acceptance-report.md) §5.8） | **已拍 A（2026-11-14）并落地**：一次执行要么全写要么不写。`applyPlan` 在任一变更是 `conflict` 时一个文件都不写、不留 `.bak`；`ck setup` 照常逐文件打印状态，末行 `nothing written: resolve the conflict(s) above, then re-run`，exit 1。~~连带消掉 codex 换 `--agent` 重跑的半新半旧~~（2026-11-15：该场景随 O-38 变成合法的原地更新路径，不再触发冲突；「整次不写」对结构性冲突照旧生效）；hermes 批准表冲突时 `config.yaml` 也不写。yaml / toml 与 json 的口径差异已由 O-38 统一 |
| O-32 | `ck doctor` 的检查项少于文档（[acceptance-report.md](acceptance-report.md) §5.5） | **已拍 A（2026-11-14）并落地**：按 install.md §5 补齐四件宿主侧检查。①「指向本机 ck」：`host_config.detail.points_to_self`（stdio 条目的 argv 里找 ck 自己的入口，http 条目 n/a 为 null，指向别处时 `host_config` 不过）；②「hook 条目存在」：json 宿主（claude-code / gemini-cli / codex）与 yaml 宿主（hermes，原有）统一查，codex 连带复算 `[hooks.state.*]` 信任表（`trust_entry_present` / `trust_enabled` / `trusted_hash_matches`，按 `commandHookHash` 与当前 hooks.json 的条目复算）；③ `skill_dir` 判据改「存在且可写，或最近的已存在祖目录可写」（写临时文件探测）——消掉「刚 setup 完 doctor exit 1」的观察项（§3 第 20 项）；④「缓存状态」：`checks.cache` 通报 `path` 与条目数，不计成败。连带落地 §5.13 e（json / toml 宿主的 hook 检查）。验证：doctor.test.ts 新增 4 例（points_to_self false、hook 缺失、祖目录是文件、cache 通报）与 codex 信任复算正反两例先红后绿，cli 223 绿；真 `ck` 进程对临时 home 六场景复核全符合。**2026-11-15 真宿主走查复跑（acceptance-report §5.13 末段）**：真 codex 0.166.0 / hermes v0.23.0 / gemini 0.68.0 / claude-code 四宿主 doctor 新检查项全绿，codex 信任表复算与换 Agent 跟随均实机确认——原「未验证：真 codex / gemini-cli 上的 doctor 全绿复跑」关闭 |
| O-33 | dsh / cinlan-harness 的配置落点（[acceptance-report.md](acceptance-report.md) §5.6） | **已拍 A（2026-11-14）并落地**：保持实现——`ck setup` 只写默认位置 `~/.dsh/cordis.patch.yml` 与 `~/.clh/cordis.patch.yml`，不展开 `$DSH_HOME` / `CLH_HOME`，不处理 profile；hosts.md §4.2 已补一句。§5.13 d 随此拍板关闭：codex / gemini-cli / hermes 同口径，三个 README 的「只读写默认位置」说明即现状 |
| O-34 | `ck setup` dry-run 不打印将写入的内容（[acceptance-report.md](acceptance-report.md) §5.1） | **已拍 A（2026-11-15）并落地**：`FileChange` 加 `preview`（ck 管的那段：yaml / toml 的标记块、json 的条目、hermes 的 allowlist 条目、markdown 的规则块），dry-run 逐文件打印（缩进对齐 detail）；unchanged / conflict 不打 preview。不打印整个文件——`settings.json` 里别人的 token 不回显。连带 §5.11：`--host generic`（`generic-mcp` 为别名，`hostConfig` 里归一到 `generic`）打印 stdio + http 两份手工片段（实际 ckEntry 与 hub 地址代入），exit 0；声明没有配置文件与 hook 即走该分支。验证：`exit.test.ts` 真进程两例（dry-run 打印 preview 且不回显 `numStartups`、generic / generic-mcp 双别名）先红后绿；S4 冒烟顺带复验（装出的 ck 对 claude-code dry-run 打印 preview、generic 打印片段） |
| O-35 | 自动物化只发生在 `ck mcp`（[acceptance-report.md](acceptance-report.md) §5.2） | **已拍 A（2026-11-15）并落地**：`ck hook session-start` 在输出协议 JSON 后、退出前同步物化（`runHook` 带出 `prepared`，`cmdHook` 调 `syncSkills`；时限按 loadout.md §6 另计 10 秒，失败记 `hook.skills_conflict` / `hook.skills_failed` 日志、exit 0 不变）。消掉「brief 宿主要等第二个会话才拿到 skill 落盘」与「generic 无 hook 宿主永不物化」两处。`reloadSkills` 仍不写（S2 未确认字段位置）。验证：`exit.test.ts` 真进程一例（带 skill 的 hub → `ck hook` → stdout 只有协议 JSON、skill 已落盘、exit 0）先红后绿 |
| O-36 | `knowledge_status` 缺 `stale` 等字段（[acceptance-report.md](acceptance-report.md) §5.3） | **已拍 A（2026-11-15）并落地**：`McpContext` 加可选 `session`（`digest / stale / skills 快照`）与 `baseline_budgets`；`ck mcp` 注入（digest 取投递文本的 digest，brief 不解析为 null；skills 快照由后台物化回填，空清单也落成 0 已物化），statusTool 填 `baseline.{digest, current_digest, changed, stale}` 与 `skills.{materialized, conflicts}`。A0（hub `/mcp`，无本机状态）不带 session：`baseline` 只有 `delivery + digest`，`changed` / `stale` / `skills` 键不出现——loadout.md §5 末条的既有约定。`current_digest` 用与 session 同一份预算解析（`baseline_budgets` 取 `instructions` ?? `hook`），changed 才可比。验证：mcp 包 `face.test.ts` +2 例、`t10.test.ts` 双面用例改为共有子集逐字段比 + ck 侧会话事实断言；cli `mcp.test.ts` +2 例（快照回填、stale 缓存路径）；cli 223 → 230 绿 |
| O-37 | skill 升版本而配装文本不变时宿主自动拿不到（[acceptance-report.md](acceptance-report.md) §5.4） | **已拍 A（2026-11-15）并落地**：hub 在 `not_modified` 时也返回 `items / skills / skipped / downgraded`（`text` / `chars` / `bytes` 为空表无需重投）；客户端 `prepare` 在 not_modified 时清单取本次应答、与缓存不同则刷新缓存（网络兜底不退回旧版本）。api.md §4、loadout.md §6 缓存表已同步；sdk fixture 不变（本来就是全量示例）。验证：core `loadout.test.ts` 短路段 + 主场景（skill 升版本、摘要行不变 → not_modified 且 `skills[0].version = 2`）；cli `prepare.test.ts` +1 例（清单刷新 + 缓存重写）；原「走查跟进」的 F1 `fresh` 机制保留（`ck skills sync` 显式手动路径） |
| O-38 | 换一个 Agent 名重跑时 yaml 与 json 行为不同（[acceptance-report.md](acceptance-report.md) §5.9） | **已拍 A（2026-11-15）并落地**：条目名 `ck`（`mcpServers.ck` / `hooks.<event>` 里 ck 的 session-start 条目）归 ck 所有，与 yaml / toml 标记块同口径——内容不同原地更新（`mergeMcpJson` / `mergeHookJson` 不再报 conflict）。换 `--agent` 重跑对全部宿主都是全量 update、exit 0；codex 的信任表随 hooks.json 的新下标与新命令重算。剩余冲突只有结构性问题（文件不是合法 JSON、`hooks.<event>` 不是列表、allowlist 根形状不对、yaml / toml 块外同名 id / 表），5.8 的「有冲突整次不写」对这些仍然生效。验证：`setup.test.ts` 重写 claude-code / codex / gemini / opencode 的同名条目用例（原地更新 + 结构性冲突触发），codex 加「换 Agent 两文件都 update、信任表跟着换」正反两例；真进程 exit 冲突用例改用坏 JSON 触发。连带 §5.13 b 关闭（换 Agent 不再是冲突路径） |
| O-39 | 写进配置的路径是反斜杠（[acceptance-report.md](acceptance-report.md) §5.10） | **已拍 A（2026-11-15）并落地**：`ckEntry()` 统一正斜杠（`fileURLToPath(...).replace(/\\/g, "/")`），Windows 写 `D:/…`、POSIX 不变；cmd / PowerShell / Git Bash 的双引杠里都原样保留（§6.9 的不确定随之消掉）。doctor 的 `points_to_self` 比较本来就做了分隔符归一。验证：S4 冒烟里安装出的 ck 写宿主配置已是正斜杠；全量测试无回归 |
| O-40 | `/dl/ck.tgz` 没有产出（[acceptance-report.md](acceptance-report.md) §5.7） | **已拍 A（2026-11-15）并落地**：`scripts/pack-ck.mjs`（`pnpm pack:ck`，根 package.json 已挂）产出 `dist/ck.tgz`：cli lib + agents + workspace 依赖（sdk / mcp）手工进 `node_modules` + registry 依赖（zod、`@modelcontextprotocol/server` 及传递）由 npm 解析，全部列 `bundledDependencies` 打进 tarball（约 3MB，大头是 MCP SDK 本体）。hub `/dl` 已有实现（`<dataDir>/dl/<file>`，路径穿越拒绝）——出线把 ck.tgz 拷进 `<dataDir>/dl/` 即生效。验证：S4 冒烟（临时目录 `npm i` → `ck --version`、claude-code dry-run、generic 片段全通，tarball 内容抽查 sdk / mcp / agents / bin 齐全）+ `/dl` 分发实测（200、字节与 sha256 一致、`/dl/../` 404）。未做：干净 Windows / Linux 机器上的完整 S4（Docker 多阶段构建也引用它，见 install.md §4 的待接线）。调试发现并已规避：npm 对 tarball 内嵌套 `file:` 依赖不支持（按 extraneous 丢弃）；npm pack 只打包「dependencies 声明且列 bundledDependencies」的包 |
| O-41 | panel 视觉：底色死灰、卡片三层叠加、chrome 与内容同层（Yorker 2026-11-15「有点丑」） | **已修（2026-11-15）**：不动信息架构与组件结构，只动 `styles.css`（+Login.tsx 4 行品牌锚点）。三件系统性的事：① 底色显式 `#f5f6f8`（实测 `--td-bg-color-page` 在 1.18.6 解析为 `#eee`，整屏死灰）；② 顶栏 / 侧栏 / t-menu 与页面底同色，白卡只属于内容；③ 卡片统一白底 + 淡边框无阴影（改前每页阴影 0–5 波动）、空态去虚线盒、`ck-input` 圆角对齐 TDesign 3px、guide 折叠条目补 hover。方法：headless 浏览器 computed-style 实测十页（改前 / 改后各一轮，`scripts/ui-measure.mjs`，2026-11-16 从 %TEMP% 收进仓库）——改后十页底色一致、阴影归零、圆角收敛 0/3/6/8/50%。验证：panel 41 测试 + `e2e:panel` 10/10 无回归。已知 gap：`--ck-text-3` 12px 提示字低于 AA 对比度（TDesign 体系值未动）；暗色未做（§6 定的亮色单主题）。**2026-11-16：对比度 gap 已闭（O-42）**——五处提示字升 `--ck-text-2`，令牌删除；暗色主题仍未做。明细见 [panel-design.md](panel-design.md) §8 末段。后补（同日实测截图反馈）：侧栏底部横滚条——`.t-default-menu` 按 Menu `width` prop 写内联 240px，而 border-box 侧栏内容区 239px，差 1px 溢出；`overflow-y:auto` 连带 overflow-x 变 auto。修法：`.ck-sider .t-default-menu { width: 100% !important }`（收起态自动跟随）+ `.ck-sider { overflow: hidden auto }`，展开/收起两态 computed-style 复测 scrollWidth==clientWidth、无横向溢出元素。再补（同日浏览器评论实测）：①「半截白带」真身是 `.t-default-menu` 被 `theme="light"` 写死白底、ul 透明没救到包装层——包装层一并透到侧栏底色；②收起态选中项是 TDesign 默认灰（同权重被压）——item 选择器提到 `.t-default-menu` 层（0,4,0）；③≤900px 媒体查询把侧栏压 56px 但 Menu 仍展开态、22 个元素溢出被裁——Shell 用 matchMedia 同步 `narrow`，窄屏 Menu 真收起（图标列）且隐藏手动开关。回归：panel 41 + `e2e:panel` 10/10。列表统一（同日「列表要统一一下」）：Assets/Reviews/Audit/Agents/Teams/Usage/AgentDetail 的表此前裸贴灰底、Access/TeamDetail 是白卡，且 Audit/Usage/Access/TeamDetail 用 `size="small"` 行高不一致——统一为全部 `<section class="ck-panel">` 包裹（Assets/Audit 连同 loadmore 一并进卡）+ 全站表格去 `size="small"`；`.ck-panel` 补 `overflow: hidden`（末行 hover 不戳出圆角）、卡内 `.ck-loadmore` 收紧为 8px 0。七页实测（assets/reviews/audit/agents/teams/usage/access）：inPanel 全 true、panel padding 16px、th 10px 12px、td 12px。回归：panel 41 + `e2e:panel` 10/10 |
| O-42 | §6 观察项里带明确改法的五件：doctor 探针预算（F11/§6.2）、doctor 缺失文件无提示（F5/§6.3）、hook.ts 死代码（§6.10）、mcp 测试临时目录泄漏（§6.10）、panel 提示字 AA 对比度（O-41 已知 gap） | **已修（2026-11-16，「取最优继续推进」）**：① doctor 的 `loadout/resolve` 探针预算取 `instructions ?? hook`（与 sync.ts / mcp.ts 同口径；max_bytes 只认 instructions 档），claude-code / codex / gemini-cli / hermes 按声明 hook 8,000 量——doctor.test.ts 补 `budget_chars=8000` 断言；② `host_config` 在文件本身不存在时也给同一条 hint（`host.mcp.file !== ""` 才提示，generic 不误伤）——补 exists:false 用例；③ hook.ts catch 里未被使用的 `const ctx: McpContext` 死块与 import 一并删除；④ mcp.test.ts 上报测试补 marker 等待（65/80/111 等 digest 落地、126 等 at 变新），`%TEMP%` 泄漏归零（历史积压 255 个 `ck-mcp-*` 已清）；⑤ panel 五处提示字（login-foot / field-hint / empty-hint / error-meta / diff-no）从 `--ck-text-3`（TDesign placeholder `#0006`≈3.8:1，不达 AA）升 `--ck-text-2`（`#0009`：白底 5.7:1、灰底 5.3:1），`--ck-text-3` 令牌删除；live 复测新构建 `index-rvK7eRof.css` 下 `--ck-text-3` 为 null、提示字 `rgba(0,0,0,0.6)`。回归：cli 231（230+1 新用例）、panel 41、`e2e:panel` 10/10 全绿 |
| O-43 | LY 授权的批量拍板（「要我拍的就用最优方案继续拍板」，2026-11-16） | 三组：① **O-7 自动沉淀**——通道 A' 客户端抽取 + 模型自报为主/手动保底（本表 O-7 行已改）；② **O-9 向量检索**——通道 A 外置 worker、PG 双实现降远期可选、迁移工具改 JSON 快照、整条资产不分块、RRF k=60 / overfetch 4×（本表 O-9 行已改，缩减了对原方向行的承诺）；③ **v2 范围**（deep-memory.md §4 三问）——只做 reflect 提议回路 + evidence trail + PII/secrets 规则预检三条，**reflect 产物进团队资产只走 update 提议**（人审裁决），graph 臂 / bank 隔离 / cross-encoder / decision model 维持不做，PII 预检可提前立项（零 LLM 依赖）。同时**确认 P2 复核队列按现状通过**：O-38（json 原地更新 + codex 信任表重算）、O-23 至 O-26（panel 样式/路由/重定向三偏差）、O-41 后补（侧栏三修 + 列表统一）、O-42（观察项五修）——维持已实现行为即最优解，复核关闭。Yorker 后续如另有意见仍按 §5 流程重开 |


## 6. 事实来源与未验证项

腾讯部分读自官方仓库 <https://github.com/TencentCloud/TencentDB-Agent-Memory>（文档站 <https://tencentcloud.github.io/TencentDB-Agent-Memory/>）：根 `README.md`、`agents/dsh/README.md`、`agents/adapter-agent-development.md`（7 类客户端、11 项能力）、`MemoryPanel/README.md` 与面板 API 文档、`MemoryProxy/README_CN.md`、`deploy/panel-knowledge-combined/README.md`、仓库目录树。

宿主部分：

- dsh：`@deepseek-ai/dsh-mcp-client`（`stdio | streamable-http` 两种传输；`DEFAULT_MAX_INSTRUCTION_BYTES = 32_768`，超限抛错；服务端 `instructions` 原文进系统提示；stdio 协商先起临时探针进程）、`packages/skill/skill-filesystem/src/index.ts`（发现根含 `~/.agents/skills`，只下探一层，缺 YAML frontmatter 或 `name` / `description` 的目录直接忽略）、`docs/user/guide/mcp-memory.zh.md`（`insert` patch 写法）、hook 桥接为实验性（`SessionStart` 有已知限制）。
- Claude Code：官方 CHANGELOG（`anthropics/claude-code`）——hook 输出超 10,000 字符改存文件并只留 2,000 字符预览；`SessionStart` 可返回 `reloadSkills: true`；`~/.claude/skills` 与 `.claude/skills` 自动热加载；MCP `instructions` 上限 4,096 字符（`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`）；401 会触发 OAuth 发现（排错项）。本机 CLI 2.1.310 的 `claude mcp add-json --help` 与 `claude mcp add --help`（`-s` 作用域、`-t` 传输、`-H` 请求头）。
- Codex CLI：`mcp_types.rs`（`command` / `url` / `bearer_token_env_var` / `http_headers` / `env_http_headers` / `http_headers_helper` / 超时）；hooks crate `session_start`（startup / resume / clear / compact / fork）、`session_end`、`stop`；`engine/discovery.rs`（`hooks.json` / `[hooks]` 双层发现、`hooks.state` 信任键 `<路径>:<事件>:<组>:<项>`、`commandWindows` 覆盖 `command` 后参与哈希）。`instructions` **不作指令级采用**（#29097 源码级证实降级为工具命名空间元数据；#6148 官方关闭不做注入）。本机 codex-cli 0.166.0 spike：`hooks` feature 默认关；SessionStart stdin 为 `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, source}`；输出 `hookSpecificOutput.additionalContext` 以 developer 消息进上下文；预写 `hooks.state`（`enabled` + `trusted_hash`，canonical JSON 键排序 sha256）可免 `/hooks` 审查；skill 根 `~/.agents/skills`（递归）+ `<CODEX_HOME>/skills/.system`；工具前缀 `mcp__<server>__<tool>`。
- Gemini CLI：0.68.0 npm bundle 源码直读（本机 spike）——`settings.json` 的 `mcpServers`（stdio `command/args`，远端 `type: "http"` + `url` + `headers`；schema 另收 `trust`/`includeTools`/`excludeTools`/`timeout`/`description`）；工具全名 `mcp_<server>_<tool>`（`MCP_TOOL_PREFIX = "mcp_"`，分隔 `_`，非 `mcp__`）；hook 事件 `SessionStart`（source：`startup | resume | clear`，无 compact——压缩是独立 `PreCompress`）等 10 种；命令 hook 形状 `{matcher?, sequential?, hooks: [{type, name?, command, timeout?}]}`，**timeout 毫秒**（`DEFAULT_HOOK_TIMEOUT = 60000`）；`enableHooks` 缺省 `true`、`disabledHooks` 按 `name || command` 禁用；`hookSpecificOutput.additionalContext` 转义 `<`/`>` 后包 `<hook_context>` 注入（交互式 `addHistory` user 消息、`gemini -p` 前置进 prompt；系统提示声明只读）；项目级 hook 走 `~/.gemini/trusted_hooks.json`（未信任只警告仍执行），用户级无审查；MCP 条目 `trust: true` + 可信文件夹免逐次调用确认；skill 根 `~/.gemini/skills` 与 `~/.agents/skills` 双扫、项目 `.gemini/skills`。

本机实测（Node v24.9.0，SQLite 3.50.4）：`node:sqlite` 可用；FTS5 `trigram` 对中文与英文 MATCH 可用、大小写不敏感、`snippet()` 与 OR 查询可用；2 字符词 MATCH 返回 0，`LIKE` 可命中；`VACUUM INTO` 后隐式 rowid 未被重排（但文档无保证，故 D-21）。

P0 §A.1 验收实测（2026-11-12，Windows 11 / Node v24.9.0 / pnpm 10.33.0）：

- `pnpm -r build` 与 `pnpm -r test` 全绿：sdk 1、core 6、hub 12、cli 8，全部通过。
- `cinlan-knowledge bootstrap --config ./knowledge.config.json --name yorker` 建库成功，`data/knowledge.db` 落盘，系统管理员用户与一次性 key 正确输出。
- `cinlan-knowledge serve` 监听 127.0.0.1:8424，`curl -fsS /healthz` 返回 `{"ok":true}`。
- `ck rpc auth/verify '{}'` 返回 `code 0`、`is_system_admin: true`、`server_version: "0.1.0"`、`teams: []`，`request_id` 形如 `req_<24hex>`。
- S3 结论已由 `core/test/core.test.ts` 固化：3 字 MATCH 命中、2 字 MATCH 返回空且 `LIKE` 命中、`VACUUM INTO` 后 `asset.seq` 与 `asset_fts.rowid` 一致。S1/S2/S5/S6 仍需真实宿主会话（dsh / Claude Code）验证。

未验证：

- 官方 MCP server SDK 的传输层能否直接挂 `node:http` 做无状态 JSON 响应 → P0 S1。
- dsh 各类客户端是否都接受 24,000 字节的 `instructions`（上限 32,768 是默认值，可配置）→ P0 S1。
- Claude Code 的 10,000 字符上限统计的是 hook 原始 stdout 还是 `additionalContext` 字段；`reloadSkills` 的字段位置 → P0 S2。
- `ck` 自包含 tarball 在干净机器上的安装 → P0 S4。**2026-11-15 部分关闭**：`pnpm pack:ck` 已产出自包含 ck.tgz（O-40），临时目录安装 + `ck --version` / dry-run / generic 全通的 S4 冒烟已过；「干净的 Windows 与 Linux」双平台完整验证仍未做。
- dsh 是否对 `~/.agents/skills` 热加载；Claude Code 之外的宿主是否有热加载 → P0 S5。
- dsh Desktop 的 `insert` patch 行为与 stdio 子进程环境 → P0 S6。
- Codex CLI 的 `additionalContextLimit` 具体语义与默认上限（文档样例 5000 未实机对比）；`codex exec` 之外的 hook 触发差异（TUI / Desktop 路径未逐一验）。
- Gemini CLI 的 `instructions` 长度限制（本适配走 `brief` + hook，不受影响）；`<hook_context>` 注入后模型对其中暗号/规则的实际遵循度 → 实机验收（§7 四项）补。
- OpenCode 的接入细节：公开文档调研已完成（[hosts.md](hosts.md) §4.7），但本机未装、未实机验证——v1 `mcp` vs v2 `mcp.servers` 兼容、Code Mode 默认下工具可用性、`instructions` 上限、prompt hook 实际形状均标注待实机确认；适配前先装机补验。Cursor 仍全部未验证，[hosts.md](hosts.md) §3 相应单元格已标注。
- ~~Hermes（Nous Research 开源 `hermes_agent`，**非腾讯系**）适配前置四拍~~ → 2026-11-13 全拍并落地 `agents/hermes/`：① 嵌套键用 `yamlcfg.ts` 行级结构化合并（不引 YAML 库，`mcp_servers`/`hooks` 两处并入一条 config.yaml 变更），不用 `hermes mcp add`（它只写 MCP，hook 与同意仍要手写同文件）；`skills.external_dirs` 不合并——skill 直接物化到 `~/.hermes/skills`。② 注入点 `pre_llm_call` 已定（`extra.is_first_turn` 门控、`{"context"}` 进 user 消息）。③ shell hook 同意代写 `shell-hooks-allowlist.json` 的 `{event, command}`（与 config.yaml 里命令行逐字符一致，`script_mtime_at_approval` 只是元数据），不启用 `hooks_auto_accept` 等全局豁免。④ home 用 `platforms.win32` 声明 `%LOCALAPPDATA%/hermes/...` + `expandHome` `%VAR%` 展开。剩余：实机验收（install.md §7 四项）。详见 [hosts.md](hosts.md) §4.6。2026-11-14 更正 ③：allowlist 的根是 `{"approvals": [...]}`，条目在 `approvals` 列表里（之前代写成顶层列表，hermes 读作不可读）；`script_mtime_at_approval` 不是纯元数据，hermes 拿它判「批准后脚本是否改过」（只告警，不拦执行），格式要与 hermes 自己写的同串。
- 腾讯侧未通读的部分：MemoryCore v3 API、MemoryKnowledge README、`agents/README.md`、资产记录的完整字段与状态枚举、MemoryCore 的存储后端、是否存在审批流（已读文档中未见）。本方案不依赖这些。
