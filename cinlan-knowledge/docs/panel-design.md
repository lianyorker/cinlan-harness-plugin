# panel 设计走查（P2 首项）

结论先行：腾讯 MemoryPanel 是**十个页面 + 一个应用壳**（登录、任务看板、Wiki、Code_Graph、Skill、Chat_Memory、可观测、成员管理、Agents 管理、API Key、使用说明）。我们的 panel 取其中八个落成七页 + 一页接入指导（`/guide`），页面顺序按 sop.md §C 看板：登录 → `/assets` → `/reviews` → `/agents` → `/teams` → `/access` → `/usage` → `/audit`。与腾讯相比有三个结构性差异：资产模型统一（腾讯是 skill / chat-memory / wiki / code-graph 四个页面各一套）、审批是我们独有的页面、没有 task 域与可观测的 ClickHouse 依赖。

本文只做设计，不含实现代码。组件库按 decisions O-12 取 TDesign React；依赖清单见 §8。所有"腾讯页面清单"条目都标了出处文件，取自固定提交（见 §1.2）。

## 1. 方法与出处

### 1.1 目的

sop.md A.3：「先做一次 panel 设计走查（本期第一项）：逐页拆腾讯 MemoryPanel 的页面清单——含「接入指南 + 客户端矩阵」页（按宿主给 `ck setup` 命令与远端 MCP 的 JSON 片段）——对照排页面顺序。」

产出：页面清单（§2）、顺序对照（§3）、逐页信息架构（§4）、接入指南页设计（§5）、设计语言（§6）、待拍问题（§7）、组件与依赖（§8）、验收要点（§9）。

### 1.2 腾讯侧快照

- 仓库：`https://github.com/TencentCloud/TencentDB-Agent-Memory`
- 分支：`feat/server_team`（默认分支；`main` 是记忆引擎分支，**不含** `MemoryPanel/`）
- 提交：`42d4cde50c5a83182fced8c584f9ddb32a620615`，2026-11-10T13:27:08Z
- 抓取方式：`gh api repos/TencentCloud/TencentDB-Agent-Memory/tarball/feat/server_team`，解包后只当数据读
- 来源记录：`%TEMP%\tx-server-team-20261113\PROVENANCE.txt`（工作区外，不入库）

下文 `web/src/...` 均相对快照里的 `MemoryPanel/web/src/`。抓取范围内的文件未经通读的部分在 §7.7 单列。

### 1.3 读法

腾讯的面板是 **RPC 透明代理 + 前端自管展示状态**：前端调 `POST /api/v1/meta/*`、`/skill/*`、`/chat-memory/*`、`/knowledge/*`，后端把请求转给内核；角色判定在前端用 `auth/verify` 返回的 `user_type` 与团队 `admin` 角色做，重点是"页面能不能进、按钮能不能点"。我们的 hub 把权限放在动作 handler 里（`access.ts`），panel 只负责按服务端返回的可见集合渲染、按 `FORBIDDEN` 渲染禁用态。因此腾讯前端里的 `ResourceGuard` / `MemberManageGuard` 一类守卫，我们只借"入口按角色收敛"这层做法，不搬守卫实现。

## 2. 腾讯 MemoryPanel 页面清单

### 2.1 登录与应用壳

| 项 | 事实 | 出处 |
| --- | --- | --- |
| 登录态 | 应用启动先检查会话：`null` = 检测中（只显示文字），`undefined` = 未登录 → `LoginGate`，否则进 `RouterProvider` | `App.tsx` |
| 登录表单 | 选"记忆实例" + 输入 User Key（占位符 `user_key，如 sk-mem-…`）；另有 iOA(WOA) 登录通道：首次用户建号后自动生成的 key **仅此一次完整展示** | `components/LoginGate.tsx`、`i18n` `login.*` |
| 错误文案 | key 无效 / 已吊销、用户不存在、实例列表读取失败分别给本地化文案 | `i18n` `login.*` |
| 全局顶栏 | 左：品牌「Memory Hub」+ 团队切换器；右：「使用说明」按钮（进 `/guide`）、语言切换、设置、用户菜单（我的资料 / 退出登录） | `layouts/GlobalHeader/index.tsx` |
| 我的资料 | 头像 + 用户名 + 角色 Tag（admin / reviewer / member）+ User ID 可复制（提示"发给团队管理员用于邀请你加入 Team"）+ 所属实例 | 同上 `ProfileModal` |
| 侧栏 | 分组菜单，可折叠；第一组固定"工作台" | `layouts/ConsoleLayout.tsx` |
| 多标签页 | 有状态 TabBar，非 affix 页可关；`role="tab"` + 键盘 Enter/Space | `layouts/TabBar/index.tsx` |
| 首次引导 | 每用户一次的高亮引导，按 admin / member 两套步骤；`/guide` 页底部可回放 | `layouts/OnboardingGuide.tsx` |
| 旧 hash 迁移 | 旧路由 hash 映射到新 path（如 `#/chat_memory` → `/memory`） | `ConsoleLayout.tsx` |

### 2.2 页面一览（路由 → 菜单）

路由定义 `routes/index.tsx`（`createHashRouter`，`ConsoleLayout` 为父级），菜单分组与顺序 `constants/menu.tsx`（`GROUP_ORDER_KEYS = ['workbench','observability','organization','assets']`）：

| 路由 | 菜单文案 | 分组 | 内容摘要 | 期 / 角色 |
| --- | --- | --- | --- | --- |
| `/` | 任务看板 | 工作台（固定） | Task 列表 / 新建 / 详情抽屉 / TAPD 导入；参与人（users/agents）与状态 | — |
| `/wiki` | Wiki 知识库 | 资产管理 | 来源 / 图谱 / 页面 / 搜索；导入 + ingest；源文件树；知识图谱 | — |
| `/code` | Code_Graph | 资产管理 | 仓库 / 索引 / 搜索 / 探索 | — |
| `/skills` | Skill 技能 | 资产管理 | 三个 scope：团队资产 / Agent 资产 / 我的资产分配；详情含 Frontmatter、正文、附属资源、历史版本；导入、Fork 给 Agent、导出、删除 | — |
| `/memory` | Chat_Memory | 资产管理 | 五个 scope：全部 / 团队资产 / Agent 资产 / 可分配资产 / 我的资产分配；L0–L3 分层；导入对话块、分配到 Agent、解绑、共享 / 私密 | — |
| `/analytics` | 线上调用情况 | 数据分析（可观测） | KPI、用量面板、成员 / 模型表、下钻抽屉、趋势、调用明细 | 仅 admin，且 env 开关 + ClickHouse 探测 |
| `/team/members` | 成员管理 | 组织与权限 | 成员 / 用户 / 角色；添加已有用户或（admin）新建用户并发 key | reviewer 不可见 |
| `/team/agents` | Agents 管理 | 组织与权限 | Agent 卡片网格；创建 / 编辑 Agent（role prompt、rules prompt、原子能力）；默认 Agent 模板（admin） | — |
| `/team/api-keys` | API Key | 组织与权限 | User_Key 管理 + 客户端接入地址（按客户端列 endpoint） | — |
| `/guide` | （无菜单项） | — | 使用说明：快速接入三步、最佳实践、记忆指令；从顶栏按钮进入，独立页不进 TabBar | 所有登录用户 |

### 2.3 逐页要点（需要借鉴/规避的具体做法）

**Skill（`/skills`）**
- 三个 scope 是同一页面的过滤维度：`团队资产` / `Agent 资产`（Fork 到 Agent 的副本）/ `我的资产分配`（"仅显示你是 owner 的资产 · 切换「共享 / 私密」决定其他 team 成员能否看到"，`i18n` `skills.personal.desc`）。
- 详情右栏：frontmatter + 正文 Markdown + 附属资源文件树（新建/编辑/删除，每次写 `version + 1`）+ 历史版本只读查看；所有写带 `expected_version` 乐观锁（`SkillDetailPane.tsx` 头注释）。
- 导入：两种入口——目录导入（`SKILL.md` + `files/`）与对话导入（贴 JSON → 抽取任务，`ImportSkillDialog.tsx`）；Fork 到 Agent 时要求改名且按 Agent 内唯一（`ForkSkillDialog`）。
- 导出 skill 为压缩包；删除有二次确认。

**Chat_Memory（`/memory`）**
- 五个 scope；记忆块按 L0–L3 分层展示，L0 原文分页且支持块内语义检索；可编辑某一层内容。
- 导入：贴 JSON messages 进 L0 → 后台蒸馏（`memory.notify.importSuccess`："导入成功 · {{count}} 条消息，tdai 后台正在蒸馏 L1/L2/L3"）。
- 分配 / 解绑 / 共享私密切换都挂在块上，不做单独页面。

**成员管理（`/team/members`）**
- 加成员两模式：`按 user_id 邀请已有用户`；`新建用户并加入团队`（仅全局 admin），可在新建时自定义 User_Key。
- 新建用户后弹一次性 key 显示弹窗："以下 User_Key 仅显示这一次，请立即复制并安全地发送给该用户。关闭此弹窗后无法再次查看该 Key。"（`createdUserKey.warning`）
- 角色提示直接写在对话框里（谁能做什么）。

**Agents 管理（`/team/agents`）**
- Agent 可见性：admin / team admin 看全团队，普通成员只看自己 owner 的（`TeamManagementPanel.tsx`）。
- 新建 / 编辑 Agent：名称、描述、role prompt、rules prompt、勾选要绑的资产（skill / chat-memory / wiki / code-graph 各自的挂载方式不同：skill 是 fork 副本，其余是引用分配）。
- 默认 Agent 模板（仅 admin）：`新成员加入团队时，将按此模板自动创建其专属默认 Agent。仅可选用团队公共资产（visibility=team），配置只对之后加入的成员生效。`（`defaultAgent.desc`）
- Session 默认配置（所有用户，仅配自己）：每次 Session Init 的 team/agent/task 默认值。
- 删除 Agent 有权限文案与级联失败提示（`SKILL_DELETE_FAILED` 单独提示去 skill 面板处理）。

**API Key（`/team/api-keys`）**
- 表格列：Key ID / Key Prefix / 创建时间 / 失效时间 / 吊销；已吊销的行不展示（`ApiKeyPanel.tsx` 注释：列表只展示 4 个核心字段，新建只需选过期时间）。
- 新建后完整 key 只在页头 Alert 里出现一次，复制成功后自动收起（防止明文久留）。
- 页面下半是"客户端接入地址"：按客户端（CodeBuddy / Claude Code / WorkBuddy / Codex / dsh / OpenCode / OpenClaw / Hermes）列出 endpoint，带复制按钮；地址由当前实例元数据拼出，不写死。
- admin 自己不能建 key（按钮对 admin 隐藏）。

**可观测（`/analytics`）**
- 三层收敛：仅 system_admin + 面板 env 开关 + 内核 ClickHouse 已配置，缺一即隐藏菜单（`ConsoleLayout.tsx` 注释）。
- 内容：KPI、用量面板、成员 / 模型表、趋势、下钻明细。

**资产可配置范围（`AssetScopeManager`，嵌在资源页里）**
- 每个 owner 管理自己资产的"团队内可配置 / 仅自己私有"两档，用 Segment 切换；无权管理的条目显示 Tag 而非切换器。
- 这是腾讯版的"可见性管理"，与我们 `asset/set-visibility` + 审批不是同一件事，见 §3.2。

**使用说明（`/guide`）**——见 §5，这是接入指南页的直接参照。

## 3. 对照我们的页面顺序

### 3.1 权威顺序

sop.md §C 226 行给出实施顺序：登录 → `/assets` → `/reviews` → `/agents`（配装编辑 + resolve 预览）→ `/teams` → `/access` → `/usage` → `/audit`。这个顺序以**实施优先级**排（先让资产与审批可走通，再做配装与治理），不以腾讯的菜单分组排。架构文档 §8 的路由表按模块列出（`/reviews` 排在 `/teams` 之后），**冲突时以看板为准**，页面本身的定义两处一致。

### 3.2 映射表

| 我们的页 | 腾讯对应 | 关系 | 差异与取法 |
| --- | --- | --- | --- |
| 登录 | `LoginGate` | 取形态 | 腾讯"选实例 + key"；我们单 hub 单实例，只留 User Key 输入 → `auth/verify`。不做 iOA 通道。key 存 `sessionStorage`（architecture §8）。错误态照腾讯分列：key 无效 / 吊销过期 / 用户禁用 / 网络失败。 |
| `/assets` | `/skills` + `/memory` + `AssetScopeManager` | 合并 | 我们统一 `asset.type`（`memory` / `skill`，P4 加 `wiki` / `codegraph`），一个列表 + 类型过滤，而不是两个页面。详情 = 正文、版本历史 diff、被哪些 Agent 绑定、用量（architecture §8）。腾讯的"共享 / 私密"切换对应我们的 `asset/set-visibility`，但**提升到 `team` 可能进审批**（这是腾讯没有的）。skill 的附属文件与本地产出沿用腾讯的文件树 + 乐观锁做法。 |
| `/reviews` | 无 | 我们独有 | 待审队列：`share` / `update` 申请、diff（浏览器算，hub 只回两份原文）、approve / reject（驳回必填 `reason`）。sop §B.4 的审批流程直接映射成本页的四个区域：队列、内容、diff、裁决。 |
| `/agents` `/agents/:id` | `/team/agents` | 取形态 + 增强 | 腾讯的"新建 Agent 时勾资产"是创建期一次性绑定；我们的配装是持续可调的绑定表：优先级、`inject` / `tool`、pin 版本、预算占用、`loadout/resolve` 文本预览（预算可调）。**预览用同一动作出文本**，客户端不拼。腾讯的"默认 Agent 模板"对应我们的 `agent/set-default-template` + `loadout/sync-template` 下发。 |
| `/teams` `/teams/:id` | `/team/members` + `DefaultAgentTemplate` + `AssetScopeManager` | 合并 | 成员与角色、团队策略（`review_mode` / `allow_self_approve`）、默认模板；腾讯一个页面承载"成员 + Agent + 默认模板"，把 Agent 管理拆到 `/agents` 后，`/teams` 只剩成员、策略、模板三块。 |
| `/access` | `/team/api-keys` + `AssetScopeManager` + 成员管理的"发 key" | 取形态 | 资产 ACL（`acl/grant` / `revoke` / `list`）、我的 key（`user-key/create` / `list` / `revoke`）；System Admin 的用户与 key 管理（`user/*`、可代建 key）。腾讯的"客户端接入地址"从本页移出，进 `/guide`（见 §5）。 |
| `/usage` | `/analytics` | 取形态，收窄 | 腾讯是通用可观测平台（依赖 ClickHouse）；我们只做 `usage/summary` 的三个视角：热 / 冷资产、按 Agent 与按宿主的用量、从未被用过的资产。数据全在 SQLite，无额外依赖。 |
| `/audit` | 无 | 我们独有 | `audit/list`：TA 看本团队、SA 看全部；筛选按动作 / 人 / Agent / 时间窗；`/audit` 是 B.7"泄露后按 key 前缀回溯"的入口。 |
| （新增）`/guide` | `/guide` + `ApiKeyPanel` 的接入地址区 | 取形态 | 「接入指南 + 客户端矩阵」页，见 §5。**architecture.md §8 没有这个路由**，需 Yorker 拍板（§7.1）。 |
| （不取）`/`、`/wiki`、`/code` | 任务看板、Wiki、Code_Graph | 不取 / 后置 | task 域不在不变量里（decisions §3"task、task-agent、participation-log、instance-quota 不取"）；wiki / codegraph 是 P4 知识工坊。 |
| （不取）设置对话框、语言切换、首次高亮引导 | `SettingsDialog`、`LanguageSwitcher`、`OnboardingGuide` | 不取（P2） | 我们无"模块开关"类设置；单语言（中文）；首次引导P2 不做，用 `/guide` 页的空态引导替代。 |

### 3.3 页面顺序的合理性核对

- `/assets` 先于 `/reviews`：没有资产就没有审批单；空态下 `/reviews` 只剩"暂无待审"。
- `/reviews` 先于 `/agents`：配装要从"已过审的团队资产"里挑，审批页先可用才能把 B.3–B.5 串起来。
- `/agents` 先于 `/teams`：团队模板属于 B.5 的下发环节，`loadout/sync-template` 需要 `/agents` 的配装编辑先可用。
- `/access` 在 `/teams` 之后：ACL 的主体（user / role / agent）来自成员与 Agent 列表。
- `/usage`、`/audit` 收尾：都是只读页，依赖前六页产生数据。

这个顺序与验收门（B.1–B.6 全程只用 panel）一致，逐页对应见 §4 每页末尾的"服务的 B 步"。

## 4. 逐页信息架构

通用约定，后文不再重复：

- 壳层：顶栏（品牌 + 团队切换 + `/guide` 入口 + 用户菜单，含身份与 `/access` 我的 key 快捷入口）；左侧分组菜单；内容区窄版单列布局（最大宽 1200–1440 px）。**不做腾讯的多标签页**：P2 只有八页，标签栏增加状态管理成本而没有信息增量。
- 每页三态必做：**空态**（说明为什么空 + 下一步动作）、**加载态**（骨架或行内 loading）、**错误态**（错误枚举 + `request_id` + 重试）。`429` 按 `Retry-After` 倒计时后重试；`401` 清 `sessionStorage` 回登录。
- 长标题与大正文：列表行标题单行截断 + `title` 悬浮全文；正文区不限高（详情页滚动），Markdown 表格允许横向滚动；skill 正文最多 `content` 上限 256 KiB（hub `limits.maxContentBytes`），超过 `PAYLOAD_TOO_LARGE` 要在表单期就拦。
- 所有写操作成功后就地刷新所涉区域，不整页重载；`VERSION_CONFLICT` 显示 `current_version` 并要求用户重新载入对比，不自动覆盖。

### 4.1 登录

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 表单 | hub 地址（默认 `window.location.origin`，只读展示）+ User Key 输入（`type=password`，可切换显示） | `auth/verify` |
| 会话 | 成功后写 `sessionStorage`：key + `Verification`（user / is_system_admin / teams / server_version） | — |
| 错误 | `UNAUTHORIZED` → "key 无效、已吊销或用户已禁用"；网络错误 → 显示 hub 地址与重试 | — |

角色收敛（全站）：SA 看到全部团队与系统页；TA 看到本团队的管理动作；M（成员）只看到自己的 Agent 与可读资产。判定以 `auth/verify` 的返回为准，前端不做名称推断（腾讯 `permissions.ts` 头注释同思路：只认 `user_type`，不用用户名兜底）。

### 4.2 `/assets` 资产库

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 过滤条 | 团队（有多团队时）、类型（memory / skill）、可见性、状态、Owner、标签；搜索框 | `asset/list`（分页 `limit` + `cursor`） |
| 列表 | 行：标题、类型、可见性、状态、Owner、版本、更新时间；skill 行显示 `name` 与文件数 | `asset/list` |
| 详情（右侧抽屉或独立区） | 正文（Markdown / 纯文本）；skill 附属文件树（`asset/get {path}`）；版本历史与 diff（浏览器算：`asset/history` + 两次 `asset/get {version}`）；被哪些 Agent 绑定（`loadout/get` 反查或详情接口附带，见 §7.4）；用量摘要 | `asset/get`、`asset/history`、`asset/update` |
| 共享 | 选 `team` / `restricted`（带 ACL 勾选）+ 必填 `note` | `asset/set-visibility` → 直接 `applied` 或 `pending_review` |
| 状态 | `activate` / `deprecate` / `archive` / `restore`；`archived` 才可 `purge`（二次确认） | `asset/set-status`、`asset/purge` |
| 新建 | 类型、标题、正文、摘要、标签、层（memory）；skill 加 `name` 与文件 | `asset/create` |

写权限：Mgr 直接改，仅可读者改 → 提议（返回 `pending_review`，页内提示并给 `/reviews` 链接）。空态："还没有资产；从本机导入（`ck import`）或在右上角新建。" 服务的 B 步：B.2、B.3、B.6 的第 1、2 步。

### 4.2b `/inbox` 收件箱（P3 O-7 补页，2026-11-16）

自动沉淀的采纳面：宿主会话经 `knowledge_session_report` 落下的私有 `draft` 资产在此裁决。侧栏「资产管理」分组第二个菜单项（全角色可见——草稿仅 owner 可读，他人的收件箱天然是空的，权限过滤在 `asset/list` 的 draft 谓词）。

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 列表 | 行：标题、类型、层、报入时间；「处理」入口 | `asset/list { status: "draft" }` |
| 抽屉 | 正文预览；采纳（保持私有 / 同时申请共享给团队，后者带 note）；丢弃（Popconfirm → 归档） | `inbox/adopt`、`asset/set-status {action: "archive"}` |

空态："收件箱是空的"。服务的验收：sop 241「草稿他人不可见，采纳后才可检索」——e2e-gate 的 S.1–S.3 段即按此走。

### 4.3 `/reviews` 审批

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 队列 | TA 默认看团队待审；任何人可切"我提交的"；行：类型（share / update）、资产、申请人、时间、状态 | `review/list`（`mine: true`） |
| 详情 | 申请说明 `note`、资产当前版本与提议版本原文并排 | `review/get`（含两份原文） |
| diff | 浏览器端逐行 diff（复用 O-2 的 `diff` 依赖） | 本地计算 |
| 裁决 | approve / reject；reject 必填 `reason`（未填时按钮禁用并提示） | `review/decide` |
| 撤回 | 申请人对自己待审单 | `review/withdraw` |

错误：`REVIEW_NOT_PENDING` → "该申请已被处理或已失效"，刷新队列。空态："暂无待审申请。" 服务的 B 步：B.4。

### 4.4 `/agents` 与 `/agents/:id` 配装

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 列表 | Agent 名、宿主、Owner、状态、绑定数、团队模板标记；TA 看全团队，M 看自己 | `agent/list` |
| 配装编辑 | 绑定表：资产、优先级（排序）、`inject` / `tool`、pin 版本（可选）；拖拽或上下移排序；整表保存 | `loadout/get`、`loadout/set` |
| 预算占用 | 当前 resolve 的 `chars` / `bytes` 对预算的进度条；预算滑块（`budget_chars`、`max_bytes`） | `loadout/resolve` 重算 |
| 预览 | `resolve` 文本（只读等宽区，可折叠）；`items` / `skipped` / `downgraded` 列表，`skipped.reason` 翻译成人话（`no_access` / `not_active` / `expired` / `name_conflict` / `budget`） | `loadout/resolve` |
| 模板 | 标记本 Agent 为团队模板 / 下发模板（`add-missing` / `replace`，带影响面确认） | `agent/set-default-template`、`loadout/sync-template`（P2 补件） |
| 生命周期 | 新建（`agent/create`）、改名 / 归档（`agent/update` / `archive`） | 同上 |

预览里展示不同宿主的效果：同一份绑定的预算按宿主不同（`brief` / `full` 与 hook 上限，见 loadout.md §4），预算滑块上方给"宿主预设"三档（`full` 24,000 字节 / hook 8,000 字符 / `brief` 1,500 字符），选一档就填进 `budget_chars` / `max_bytes`。**文本一律来自 `loadout/resolve`，客户端不重排不截断**（不变量 5）。空态："该 Agent 还没有绑定资产；从上方搜索团队资产加入，或用模板下发。" 服务的 B 步：B.5。

### 4.5 `/teams` 与 `/teams/:id`

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 概览 | 团队名、成员数、资产数、Agent 数 | `team/get` |
| 成员 | 列表：名字、角色、加入时间；变更角色（保证至少一名 TA）、移除 | `team-member/list` / `set-role` / `remove` |
| 邀请 | 按 slug / user_id 添加已有用户；SA 可"新建用户并发 key"（一次性展示，复制后自动收起，沿用腾讯 `CreatedUserKeyModal` 的做法） | `team-member/add`、`user/create-with-key` |
| 策略 | `review_mode`（off / share / all）、`allow_self_approve` | `team/update` |
| 默认模板 | 指定团队模板 Agent；下发按钮与模式选择 | `agent/set-default-template`、`loadout/sync-template` |
| 删除团队 | SA；有资产或 Agent 时禁用并给原因 | `team/delete` |

空态（非 TA）："你不是该团队管理员，只能查看。" 服务的 B 步：B.1、B.5（模板部分）、B.7（离职处理入口）。

### 4.6 `/access` 访问控制

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 资产 ACL | 选一个自己有管理权的资产 → 主体（user / role / agent）× 权限（read / manage）列表；增删 | `acl/list`、`acl/grant`、`acl/revoke` |
| 我的 key | 列表：`prefix`、名字、创建 / 最后使用 / 状态；新建（可设过期）→ 明文一次性展示；吊销 | `user-key/list` / `create` / `revoke` |
| 用户与 key 管理（SA） | 用户列表：状态、团队；新建（`user/create` 或 `create-with-key`）、禁用；按用户看 key 与代建 | `user/list` / `get` / `create*` / `disable`、`user-key/*` |
| 自查 | 我 / 我的 Agent 对某资产的权限 | `acl/check` |

安全约束：key 列表只回 `prefix`，明文只在 `create` 响应出现一次。服务的 B 步：B.7。

### 4.7 `/usage` 用量

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 概览 | KPI：资产总数、近 30 天被注入次数、零用量 `team` 资产数、按宿主分布 | `usage/summary` |
| 按资产 | 热 / 冷排序表；点行进 `/assets` 详情 | `usage/summary` |
| 按 Agent / 宿主 | Agent 维度与宿主维度的表；`skipped` 多的 Agent 高亮（对应 B.6 第 3 步） | `usage/summary` |
| 从未用过 | `team` 可见、180 天内零 `injected` / `opened` 的资产列表，带"去废弃 / 去归档"快捷 | `usage/summary`、`asset/set-status` |

权限：TA / SA；普通成员看不到（`FORBIDDEN` 时菜单不出现）。服务的 B 步：B.6。

### 4.8 `/audit` 审计

| 区域 | 内容 | 动作 |
| --- | --- | --- |
| 过滤 | 动作名、操作人、Agent、时间窗、团队（SA） | `audit/list` |
| 表 | 时间、动作、操作人、Agent、对象、结果码、`request_id` | 同上 |
| 追溯 | 点 key 前缀筛出该 key 的全部操作（B.7 泄露响应） | `audit/list` |

正文与 key 不出现在审计里（不变量 8）；页面上不提供导出（避免把审计内容带出 hub）。服务的 B 步：B.7。

## 5. 接入指南 + 客户端矩阵页（`/guide`）

### 5.1 定位

sop A.3 要求本页"按宿主给 `ck setup` 命令与远端 MCP 的 JSON/YAML/TOML 片段"。它是把 hosts.md §3–§4 的矩阵**变成可复制的操作**，而不是再写一份文档——文档是权威，页面从声明生成。

入口：顶栏"接入指南"按钮；独立页（无侧栏高亮、不占菜单项），从页内"返回"回上一页。腾讯 `/guide` 同构。

### 5.2 信息架构

```
/guide
├─ 页头      标题「接入指南」｜副标题一句话｜hub 地址（只读 + 复制，取自 window.location.origin）
├─ 区块 A 三步接入（步骤条）
│    1. 安装 ck      npm i -g <hub>/dl/ck.tgz          [复制]
│                    备注：Node ≥ 20；/dl 未产出时显示「当前 release 未提供安装包」（§7.2）
│    2. 登录          ck login --hub <hub>              [复制]（提示 key 从 stdin 输入，见区块 C 取 key）
│    3. 接入宿主     按宿主选卡 → 命令 + 文件片段        [复制]
├─ 区块 B 客户端矩阵（宿主卡片网格）
│    每卡：宿主名｜接入等级 A1/A0｜送达方式（hook / instructions / tool）｜期（P1 / P2 / 按需）
│    展开后三段：
│      B1 A1 命令      ck setup --host <h> --agent <team>/<name>   （先预览，--write 落盘）
│      B2 手工片段     MCP 条目 + hook 条目（按 host.json 的 format 给 JSON / YAML / TOML）
│      B3 说明         skill 目录、验收入口（ck doctor / 会话内见到注入文本）
│    宿主顺序：dsh → cinlan-harness → Claude Code → Codex CLI → Gemini CLI → OpenCode → 通用 MCP 宿主
├─ 区块 C 我的 key     前缀列表 + 「新建 key」→ 明文一次性展示 → 指向 /access 完整管理
├─ 区块 D 导入本机 skill  ck import --source <h>（按 hosts.md §8 的扫描表逐宿主列）
└─ 区块 E 排错         ck doctor 输出怎么读；401 / 403 / 404 的三种含义；RATE_LIMITED 与 Retry-After
```

### 5.3 关键设计规则

1. **不出现真 key**。A0 片段里 `Authorization: Bearer <your-user-key>` 用占位符；页面明确写"key 在 `/access` 新建，只显示一次"。腾讯同规则：`API Key 一律使用占位符，不出现真实密钥`（`GuidePage` 头注释）。
2. **片段与声明同源**。宿主差异在 `agents/<host>/host.json` 与 `templates/`，不在页面里手抄。panel 只允许 import `sdk`（不变量 10），所以页面拿宿主声明的方式要先定（§7.3）。在那之前，片段以静态表进 panel，并与 `agents/<host>/templates/` 逐字对照做一次手工核对，把差异计为缺陷。
3. **命令参数来自当前身份**。`--hub` 取 `window.location.origin`；`--agent <team>/<name>` 给当前用户所在团队与一个占位 agent 名（如 `cc-ly`），并提示"每个宿主一个 Agent 名"。
4. **按接入等级分两栏**：A1（装了 `ck`）与 A0（装不了 Node）。A0 片段给远端 `/mcp` + 三个请求头（`Authorization`、`x-ck-agent`、`x-ck-host`），并提示"key 会落进宿主配置，优先 A1"。
5. **"未验证"格子的呈现**：hooks.md §3 里标"未验证"的宿主能力（Codex 的 hook 配置、Gemini 的 hook 形状等），页面不得写成确定事实——对应片段后面加"实验性，失败时自动降级为 tool 方式"一行。OpenCode / Hermes 在 P2 未完成适配，卡片标注"P2 待 spike / 调研"，不给可复制片段。
6. **收尾给验收动作**：每个宿主的卡片末行是"验收：`ck doctor --host <h>` 全绿；新会话里模型能引用一条团队资产"，与 install.md §7 的四项对应。

## 6. 设计语言

### 6.1 系统与方向

- 产品形态：内部管理后台（数据密集、表单 + 表格 + 抽屉）。
- 组件库：**TDesign React**（O-12），图标包 `tdesign-icons-react`。这是腾讯自家设计系统，「参考腾讯管理后台」观感最接近。
- 说明：腾讯这版 MemoryPanel 实际用的是 `tea-component` 2.8 + Tailwind + Zustand（不是 TDesign），且不是腾讯当前对外推荐的后台栈；O-12 已拍 TDesign，本文按 TDesign 落。
- 基调：中性、克制、信息优先。不新增 UI 字体、不引 Tailwind（O-2 已排除），样式用 TDesign 的 CSS 变量与少量项目 CSS。

### 6.2 令牌（用 TDesign 默认，仅列本项目的用法约定）

| 维度 | 取值 | 说明 |
| --- | --- | --- |
| 字号 | 12 / 14 / 16 / 20 / 24 | 正文 14，表头 12，页面标题 20，登录页标题 24；表格内不用 11 |
| 行高 | 正文 1.5，CJK 1.6–1.8，标题 1.25 | 长正文区按 1.7 |
| 间距 | 4 的倍数，常用 8 / 12 / 16 / 24 / 32 | 分区 24–32，组内 8–12 |
| 圆角 | 4（控件）/ 8（卡片 / 抽屉）/ 无其他 | 不叠第三档 |
| 颜色 | 主色 TDesign 默认蓝；语义色只用 success / warning / error 表达状态；中性灰做 80% 表面 | 状态枚举与颜色一一对应：`active` 绿、`deprecated` 橙、`archived` 灰、`pending_review` 蓝 |
| 字体 | 系统字体栈（`system-ui` 优先，含 `"Microsoft YaHei"`）| 不引 Web 字体 |

### 6.3 页面骨架

```
┌────────────────────────────────────────────────────────────┐
│ 品牌          [团队: cinlan ▾]        [接入指南]  [用户 ▾] │ 56px
├──────────┬─────────────────────────────────────────────────┤
│ 资产库    │  页面标题                       [主操作]       │
│ 审批      │  ─────────────────────────────────────────      │
│ 配装      │  过滤条                                          │
│ 团队      │  ┌───────────────────────────────────────────┐  │
│ 访问控制  │  │ 列表 / 表格                                │  │
│ 用量      │  └───────────────────────────────────────────┘  │
│ 审计      │                                                  │
└──────────┴─────────────────────────────────────────────────┘
  240px 可折叠
```

- 侧栏 240 px，可折叠为 56 px 图标栏；菜单分组标题：资产管理（`/assets`）、治理（`/reviews`、`/usage`、`/audit`）、配装与组织（`/agents`、`/teams`、`/access`）。分组只影响视觉，不影响 §3.1 的实施顺序。
- 详情一律右侧抽屉（480–640 px），不跳页，除非需要深链（`/agents/:id`、`/teams/:id`）。
- 主操作每页一个（新建资产 / 裁决 / 保存配装 / 添加成员 / 新建 key），放在标题行右侧。

### 6.4 组件映射（TDesign）

| 用途 | TDesign 组件 | 备注 |
| --- | --- | --- |
| 布局 | `Layout` | 顶栏 + 侧栏 + 内容 |
| 菜单 | `Menu`（含 `SubMenu` 分组） | 折叠态用 `MenuItem` 图标 |
| 表格 | `Table` | 行高 44，`pagination` 接 `cursor` 时改页内翻页器（§7.5） |
| 过滤 | `Select` + `Tag` 筛选 + `Input` | 状态 / 可见性用 `Tag` 多选 |
| 抽屉 | `Drawer` | 详情、diff 用 |
| 对话框 | `Dialog` | 新建、一次性 key 展示 |
| 表单 | `Form` + `FormItem` | 校验用 TDesign `Form` rules |
| 消息 | `Message`（成功/失败）、`Notification` | 错误带 `request_id` |
| 空态 | `Empty` | 文案必带下一步动作 |
| 加载 | `Loading` / 表格 `loading` | — |
| 状态标签 | `Tag`（theme 与状态枚举映射） | 不用 emoji |
| Markdown 正文 | 不引组件：只读，`white-space: pre-wrap` + 代码块样式；**不引 react-markdown**（O-2 未批） | 若后续需要渲染 Markdown，先报备 |
| diff | `diff` 库（O-2 已批） | 浏览器端算，样式自写 |
| 图标 | `tdesign-icons-react` | 不用 emoji，不用 lucide |

### 6.5 状态设计

- 空态：每页三段（图标 + 一句说明 + 主操作）。示例：`/assets`："当前筛选下没有资产。清除筛选，或新建一个 private 资产。"
- 错误态：操作失败用 `Message`（错误枚举 + 人读文案 + `request_id`），页面级失败（如列表加载）用内联错误块 + 重试按钮；`429` 显示剩余秒数并禁用重试。
- 加载：列表用 `Table loading`；详情抽屉用骨架；预览区用行内 loading。
- 权限态：不可见 = 不出现（hub 返回的集合里就没有）；可见但无权限 = 按钮禁用 + `Tooltip` 说明（如"仅 Mgr 可改"）。

## 7. 待拍问题（不自行决定）

以下各项是走查发现的文档/语义冲突或未决设计，处理方式按 CLAUDE.md：停手报，不改权威文档。编号 `PD-n` 供 Yorker 回复时引用。

**拍板结果（2026-11-13，Yorker 拍板）：**

| 编号 | 决定 |
| --- | --- |
| PD-1 | `architecture.md` §8 加 `/guide` 路由（期 P2，纯前端，只调 `auth/verify` 与现有 key 动作） |
| PD-2 | P2 补件加「build 产出 `ck.tgz` + sha256」，`/dl` 实现后 `/guide` 写真实安装命令 |
| PD-3 | A：构建时把 `agents/<host>/` 打成一份 JSON 进 panel 静态资源，不新增动作、不改不变量 |
| PD-4 | 详情页先省去「被哪些 Agent 绑定」区块；需要时按加法给 `asset/get` 补返回字段 |
| PD-5 | 不改 API：表格用「加载更多」或前端缓存页码化；不为此加总数字段 |
| PD-6 | 设 64 KiB 阈值：超过降级为「并排查看 + 折叠」，不做行级 diff |
| PD-7 | 矩阵页只列「已适配 / P2 在做 / P2 调研」三组，未验证宿主不出现 |
| PD-8 | 不补读腾讯未通读部分，做到对应期（P4 / 不取项）再对照 |

**开发约定：** 实现过程中如果发现比拍板方案更好的做法，先列出来给 Yorker 重审，拍板前不直接替换。

原清单（存档）：

**PD-1 接入指南页没有路由位。** `architecture.md` §8 的路由表没有 `/guide`，而 sop A.3 与本次任务都要求这一页。建议：在 §8 加一行 `/guide`（期 P2，纯前端、只调 `auth/verify` 与现有 key 动作）。拍板后我改 architecture 并实现；在此之前 `/guide` 按本文设计但排在 §3.1 顺序之外（不影响 B.1–B.6 验收门）。

**PD-2 `ck.tgz` 未产出。** `/guide` 的安装命令依赖 `/dl/ck.tgz`，当前 hub 未实现 `/dl`（acceptance-report §5.7）。两选：在 P2 补件里加"build 产出 `ck.tgz` + sha256"（推荐，architecture §9 已把两者绑定），或 `/guide` 先显示"当前 release 未提供安装包，改用仓库内 `ck` 入口"。**已解决（2026-11-15，acceptance-report §5.7 拍板 A）**：`pnpm pack:ck` 产出 `dist/ck.tgz`，hub `/dl` 分发（`<dataDir>/dl/` 下已实测 200 + sha256 一致 + 路径穿越 404）；`/guide` 文案维持现状——hub 出线时把 ck.tgz 放进 `<dataDir>/dl/` 即生效。

**PD-3 宿主声明如何到页面。** panel 只允许 import `sdk`（不变量 10），而客户端矩阵需要 `agents/<host>/host.json` 与模板的内容。三选：
- A：构建时把 `agents/<host>/` 打一份 JSON 进 panel 的静态资源（不新增动作，不改不变量；版本随 panel 构建）。**推荐**。
- B：hub 新增只读动作 `host/list`（返回声明与模板渲染结果），面板调用。要改 api.md，属加法。
- C：页面写死片段——不可取，会与 `agents/<host>/` 漂移。

**PD-4 `/assets` 详情"被哪些 Agent 绑定"。** 现有动作里没有"按资产反查绑定"（`loadout/get` 是按 Agent 查）。两选：详情页只显示"被 N 个 Agent 绑定"的计数（要新增字段或动作），或省去该区块，用户去 `/agents` 自查。建议先省去，P2 验收门不依赖它；若 Yorker 要，按加法补 `asset/get` 的返回字段。

**PD-5 游标分页与表格。** TDesign `Table` 分页器是页码模型，我们的 API 是 `cursor`。建议表格用"加载更多"或页码化（前端缓存已取的页），不为 UI 改 API。若希望页码体验，可在 P2 补件里给 `asset/list` 等加总数字段——不做，除非 Yorker 要求。

**PD-6 `/reviews` 的 diff 数据量。** `review/get` 回两份原文，大资产（接近 256 KiB）在浏览器 diff 可能卡顿。建议超过 64 KiB 时降级为"并排查看 + 折叠"，不做行级 diff；阈值待 Yorker 认可。

**PD-7 许可范围未覆盖的宿主在矩阵页的呈现。** hosts.md §3 有 Cursor / CodeBuddy / WorkBuddy / OpenClaw / Pi 等"按需"宿主，未验证。建议矩阵页只列"已适配 / P2 在做 / P2 调研"三组，其余不出现，避免把未验证内容呈现为可用。

**PD-8 腾讯快照未通读部分。** `MemoryPanel/panel-api-doc.md`（43 KB）、`pages/AnalyticsPage` 实现、`pages/WikiPage` / `CodePage` 实现、`GuidePage` 的 i18n 全文未逐行通读——它们对应我们 P4 / 不取的部分，不影响 P2 页面 IA。若 Yorker 要求补齐某页的逐条对照，再补读。

## 8. 组件库与依赖

O-2 + O-12 合计的 `packages/panel` 依赖（新增任何一项都要先问 Yorker）：

```json
{
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "diff": "^8",
    "tdesign-react": "^1",
    "tdesign-icons-react": "^0.4"
  },
  "devDependencies": {
    "vite": "^7",
    "typescript": "^5.9"
  }
}
```

- 版本号在开工时以实际 stable 为准（上面是范围，不是锁定的具体版本）；`tdesign-react` 与 React 19 的兼容性开工前验证一次（`peerDependencies`）。
- 不引：Tailwind、Zustand、react-router（八页用 TDesign 自带的导航与 `window.history` 或最小路由，见 PD 提议——若坚持路由库，需报备）、react-markdown、动画库、图标库（tdesign-icons 除外）。
- 样式：TDesign 主题 CSS 变量 + 每页一个 CSS Module；不使用全局工具类。

**2026-11-13 落地记录（实现时的实际版本与两处偏差）：**

实际安装（`packages/panel/package.json`）：`react` / `react-dom` ^19.3.1、`tdesign-react` ^1.18.6、`tdesign-icons-react` ^0.6.12、`diff` ^9.0.0、`vite` ^8.3.8、`typescript` ^7.0.2，加 `@types/react` / `@types/react-dom` ^19.3.0（O-22）；未新增其他依赖。React 19 需在入口先 `import "tdesign-react/es/_util/react-19-adapter"` 再挂载，样式走 `tdesign-react/es/style/index.css`。

两处偏差（按 §7 规矩列出，等 Yorker 重审，暂按现状）：

1. **样式不是「每页一个 CSS Module」，而是一份全局 `src/styles.css`**（`ck-*` 语义类 + `:root` 令牌）。原因：八页共享同一套壳、表格、状态块与详情栅格，拆成 CSS Module 会把同一批类名在八个文件里重复声明，或逼出更重的抽象；单文件 780 行仍按 §6 的令牌分层组织（壳 / 页面头 / 状态 / 代码 / 详情栅格 / 配装 / KPI / diff / 指南）。如坚持 CSS Module，改造成本约一天，样式本身不用改。
2. **`/audit` 的 detail 悬浮层用 `Popup`，时间筛选用原生 `<input type="datetime-local" class="ck-input">`**。原因：TDesign 1.18.6 没有导出 `Popover`（只有 `Popup` / `Popconfirm`），`Input` 的 `type` 联合也不含 `datetime-local`。视觉上按 `ck-input` 令牌对齐，不引入新组件。

**2026-11-15 视觉收敛（Yorker 提「有点丑」后的整轮精修，decisions O-41）：**

§6 的令牌骨架不变（字号 12/13/14/20/24、4pt 网格、主色只用 TDesign 主色），改的是三件系统性的事——改前先用 headless 浏览器对十页做了 computed-style 实测（`scripts/ui-measure.mjs`，当时在 `%TEMP%`，2026-11-16 收进仓库；种子为真实感中文数据）：

1. **底色写死为冷调浅灰 `#f5f6f8`**：实测发现 `--td-bg-color-page` 在 1.18.6 里解析成 `#eeeeee`——整屏死灰是「丑」的第一来源。改为显式值，不再依赖 TDesign token 的解析。
2. **chrome 与内容分层**：顶栏、侧栏（含 `t-menu` 强制透明）与页面底同色，白卡只属于主区；消掉「白侧栏 + 灰底」的后台模板感。
3. **卡片语言统一为一层**：白底 + 极淡边框（`#e8e9ec`）、无阴影（实测改前每页阴影 0–5 个波动）；浮层（登录卡）才允许影。空态去掉虚线盒改纯排版；`ck-input` 圆角 4→3 对齐 TDesign 控件；侧栏菜单项 6px 圆角；`/guide` 折叠条目补 hover 反馈；登录页加品牌圆形图标锚点（整块面板唯一允许的「大胆」位置，`Login.tsx` +4 行）。

改后实测：十页 `bodyBg` 全部 `rgb(245,246,248)`、页面阴影归零、圆角集合收敛为 0/3/6/8/50%。`pnpm -F panel build` + 41 测试 + `e2e:panel` 10/10 无回归。已知 gap：`--ck-text-3`（TDesign placeholder 色，≈3.8:1）用于 12px 提示文字低于 AA 4.5:1，属 TDesign 体系值未动，在意的话升 `--ck-text-2`；暗色主题未做（`theme="light"` 全局，panel-design §6 当时就定亮色单主题）。**2026-11-16：对比度 gap 已闭（O-42）**——五处提示字（login-foot / field-hint / empty-hint / error-meta / diff-no）升 `--ck-text-2`（`#0009`，白底 5.7:1、灰底 5.3:1，达 AA），`--ck-text-3` 令牌删除；暗色主题仍未做。

**2026-11-16 侧栏修复与列表统一（LY 截图反馈两轮：菜单栏不对 / 列表要统一，decisions O-41 追记）：**

1. **侧栏 1px 横向滚动条**：TDesign `Menu` 的 `width={[240,56]}` 往 `.t-default-menu` 写内联 `width:240px`，而 sider 内容 border-box（含滚动条后 239px）差 1px，叠加 `overflow-y:auto` 按规范判 `overflow-x:auto`。修法：`.ck-sider .t-default-menu { width: 100% !important }` + `.ck-sider { overflow: hidden auto }`。
2. **「半截白带」根因**：`Menu theme="light"` 的白底写死在 `.t-default-menu` wrapper 上，inner ul 透明盖不住——上一轮的「`t-menu` 强制透明」策略失效。修法：wrapper 改 `background: transparent`；菜单项选择器提到 `.ck-sider .t-default-menu .t-menu__item…`（0,4,0 压过 TDesign 默认），折叠态 active 项从默认灰恢复品牌蓝。
3. **窄视口自动收起**：原 ≤900px 媒体查询只把 sider 压到 56px，Menu 仍展开态 → 22 个元素溢出被裁。`Shell.tsx` 用 `matchMedia("(max-width: 900px)")` 同步 `narrow` 状态，`folded = collapsed || narrow`，窄屏隐藏手动折叠按钮。
4. **列表统一进白卡**：Assets/Reviews/Audit/Agents/Teams/Usage/AgentDetail 的表此前裸贴灰底、Access/TeamDetail 在白卡，且 Audit/Usage/Access/TeamDetail 用 `size="small"` 行高劈两派。统一：全部 `<section class="ck-panel">` 包裹（Assets/Audit 连 loadmore 进卡）、全站表格去 `size="small"`（按钮保留）；`.ck-panel` 补 `overflow: hidden`（末行 hover 不戳出圆角）、卡内 `.ck-loadmore` 收紧 8px 0 0。

实测：七页（assets/reviews/audit/agents/teams/usage/access）inPanel 全 true、panel padding 16px、th 10px 12px、td 12px、同一 `#e8e9ec` 分隔线；展开/折叠/窄窗三态逐一看过。回归：panel 41 + `e2e:panel` 10/10。


## 9. 验收要点（与 §C 看板对齐）

- 本文勾掉 §C 225 行后，panel 实现（226 行）按 §3.1 的顺序落地。
- 每页交付时对照 §4 的表格逐行检查：区域齐全、动作映射到 api.md 已注册的动作、三态齐全（空 / 加载 / 错误）、长标题与大正文有处理。
- 验收门（sop §C 231）：不靠 CLI 仅用 panel 走完 B.1–B.6；每页的"服务的 B 步"是这条门的最小路径。
- 本文不产出代码；§7 的 PD-1 至 PD-8 已于 2026-11-13 拍板，panel 实现按拍板结果推进（开发中发现更优方案时先报 Yorker 重审）。
