# SOP

A 部分是实现顺序与验收门，B 部分是上线后的日常操作。

## A. 实现 SOP

### A.0 总则

- **契约先行**：每个动作先在 `sdk` 写入参 / 出参类型与 fixture，再写 core，最后接 hub。
- **顺序**：`sdk → core → hub → mcp → cli → agents/<host> → panel`。上一层的测试不绿不进下一层。
- **测试走公开接口**：core 测它导出的函数，hub 测 HTTP，MCP 面用官方 client 走协议。不为可测性抽浅函数。
- **偏离先改文档**：与 [blueprint.md](blueprint.md) 冲突时，先改 blueprint 与 decisions，再写代码。
- **一次性代码**：spike 代码标注 throwaway，结论写回 decisions.md 后删除。
- **新依赖先报备**：除已列明的 N-1 / N-2 / N-3（MCP SDK，见 [decisions.md](decisions.md) §5）与 O-2 的 panel 依赖外，任何新增都先问 Yorker。
- **超出文档先分析**：v2 级能力（见 [comparison.md](comparison.md)「P3 之后还剩什么」：深层记忆智能、企业级能力等）一律先回 docs 补分析、补规格、过拍板，再写代码；不凭对话里聊过的结论直接开工。

### A.1 P0：骨架、契约、spike

任务：

1. 仓库骨架：`pnpm-workspace.yaml`（`packages/*`、`agents/*`），TS 配置与 `cinlan-knowledge-sync` 对齐。
2. `sdk`：信封、错误枚举、P1 全部动作的类型、fixture。
3. `core`：`db.ts` + migration `0001`（[data-model.md](data-model.md) §1 的全部表）。
4. `hub` 最小壳：动作注册表、认证、Origin 校验、`/healthz`、`/dl/*`、`auth/verify`；CLI `bootstrap` / `serve` / `backup`。
5. 六个 spike：

| 编号 | 验证什么 | 做法 | 不通过怎么办 |
| --- | --- | --- | --- |
| S1 | 官方 MCP server SDK 能否挂在 `node:http` 上做无状态 Streamable HTTP（JSON 响应），并被 dsh 的 mcp-client 以 stdio 与 streamable-http 两种传输连上；`instructions` 进系统提示；24,000 字节的 `instructions` 被接受 | 一次性 server：一个工具 + 一段 24,000 字节的 `instructions`；dsh 里两种传输各连一次，让模型复述工具名与指令里的句子 | 改用 `@modelcontextprotocol/node`（已是 N-3）；若仍不通，dsh 走 stdio-only，远端 HTTP 推迟到 P2 |
| S2 | Claude Code：stdio MCP + `SessionStart`（startup / clear / compact）的 `additionalContext` 生效；8,000 字符不被改存文件；`brief` 不被截断；`reloadSkills` 的字段位置 | 一次性 hook 输出固定文本与 8,000 字符上下文，各触发一次 startup / clear / compact | hook 降级为 `instructions`（Claude Code 的 `instructions` 上限 4,096 字符，只能送 `brief`）；skill 热加载的结论同步给 [loadout.md](loadout.md) §7 |
| S3 | 目标部署机的 Node 版本上 `node:sqlite` + FTS5 trigram 可用；`VACUUM INTO` 后 `asset.seq` 稳定 | 建表、中英文 MATCH、`snippet()`、备份后比对 `seq` | 升 Node，或在 `db.ts` 换驱动（需依赖审批） |
| S4 | `ck` 能打成自包含 tarball，经 `npm i -g http://<hub>/dl/ck.tgz` 在干净的 Windows 与 Linux 上装好并运行 | `pnpm deploy` + `npm pack`（`bundledDependencies`）；装完跑 `ck doctor` | 引入打包器（需依赖审批，属 N 类新依赖） |
| S5 | `~/.agents/skills/<name>/` 能否被 dsh 发现（是否需重启）；`~/.claude/skills/<name>/` 能否被 Claude Code 发现并热加载 | 手工放一个带 `SKILL.md` 与 YAML frontmatter 的目录 | 该宿主降级为纯工具检索，不物化 skill |
| S6 | dsh Desktop 的 `insert` patch 写法与 stdio 子进程环境（PATH、`node` 可达、工作目录） | 用 `ck setup --host dsh` 写一次，托盘退出重启后看 MCP 条目是否加载 | 文档写明用绝对路径与手工兜底配置 |

验收门：

```bash
pnpm install && pnpm -r build && pnpm -r test
cinlan-knowledge bootstrap --config ./knowledge.config.json --name yorker
cinlan-knowledge serve --config ./knowledge.config.json
curl -fsS http://127.0.0.1:8424/healthz          # {"ok":true}
ck rpc auth/verify '{}'                          # code 0，is_system_admin = true，含 server_version
```

六个 spike 的结论写进 [decisions.md](decisions.md) §6，"未验证"清单相应删减。S1 / S2 的结论直接决定 [hosts.md](hosts.md) §3 矩阵里 dsh 与 Claude Code 行的送达方式。

### A.2 P1：后端闭环 + MCP + ck + 参考宿主

core，按此顺序，每步带测试：

1. meta：user / user-key / team / member / agent（含 `agent/ensure` 的模板拷贝）。
2. asset：创建、版本、`content_hash`、状态机、大小与路径校验。
3. access + acl。
4. loadout：bind / set / resolve（收窄、去重、预算、降级、渲染、digest）。
5. review：策略判定、申请、裁决、stale。
6. search：FTS 维护、短词兜底、排序。
7. usage + audit。

然后 hub 接全部 P1 动作与 `/mcp`（经 `packages/mcp`）；再做 `cli`：`login` / `setup` / `mcp` / `hook` / `skills` / `doctor` / `rpc`；最后做三个参考宿主 `agents/dsh`、`agents/cinlan-harness`、`agents/claude-code`（声明、模板、接入手册；cinlan-harness 复用 dsh 的模板变体，见 [hosts.md](hosts.md) §3）。

必须有的测试：

| 编号 | 内容 |
| --- | --- |
| T1 | 权限矩阵：调用者关系 × 可见性 × 状态 × 读 / 管，全枚举，期望值取自 [data-model.md](data-model.md) §3 |
| T2 | 审批策略矩阵：data-model §6 的表全枚举，含自批与非自批 |
| T3 | 并发语义：同一审批单裁决两次 → 第二次 `REVIEW_NOT_PENDING`；两次 update 用同一 `base_version` → 第二次 `VERSION_CONFLICT` |
| T4 | resolve 确定性：同输入 digest 相同；改内容或顺序 digest 变；超预算项降级而不丢；`if_digest` 短路；同名 skill 去重 |
| T5 | 检索：2 字中文词、3 字以上中文词、英文、大小写；`deprecated` 降权；过期与不可读资产不出现 |
| T6 | 不泄露：不可见资产的 get / search / bind / acl 全是 `NOT_FOUND`；按 Owner 建立的同名私有 skill 不互相泄露 |
| T7 | `system/integrity` 对全库复算，0 条不一致（**挪 P2**，O-14：`system/*` 属 P2 后端补件，P1 不实现） |
| T8 | key 吊销后立即 401；`ck` 收到 401 输出错误提示、不读缓存、删该 Agent 的缓存文件 |
| T9 | 契约：hub 的真实响应与 sdk fixture 逐字段一致 |
| T10 | MCP 契约：官方 client 分别连 hub 的 `/mcp` 与 `ck mcp`，同一组调用结果一致；`instructions` 与 hook 输出的文本同源 |
| T11 | `ck setup`：空配置、已有无关条目、同名条目内容一致（幂等）、同名条目内容不同（拒绝）四种输入，每种宿主一份 golden 文件 |
| T12 | 字节上限：全中文配装在 `max_bytes = 24000` 下不超限、超限项降级、digest 稳定 |
| T13 | 物化：标记文件、引用计数、无标记目录不动、路径穿越被拒 |

验收门（"读档" e2e，写成一个脚本，起临时 hub 跑完即删库）：

```
1. bootstrap → 建团队 demo → 建用户 A（admin）、B（member）并发 key
2. A 建记忆 M1（inject 绑定用）→ 共享到团队（自批生效）；建 skill S1 → 共享
3. A 建模板 Agent，绑定 M1（inject）与 S1（inject），设为团队默认模板
4. B agent/ensure → created = true，template_applied = 2
5. B loadout/resolve → text 含 M1 标题；skills[] 含 S1；digest 稳定；bytes ≤ max_bytes
6. B 建私有记忆 M2 → A asset/search 搜不到；A asset/get M2 → NOT_FOUND
7. B asset/set-visibility M2 → pending_review；A 仍搜不到
8. A review/decide approve → A 搜得到 M2
9. B 对 M1 提议修改（base_version = 当前版本）→ pending_review；A reject 不带 reason → REASON_REQUIRED；
   B 再用过期的 base_version 提交 → VERSION_CONFLICT
10. A 吊销 B 的 key → B 任意调用 401
```

加上实机验收：[install.md](install.md) §7 的宿主侧四项，dsh 与 Claude Code 各过一遍。

### A.3 P2：控制台、治理与更多宿主

先做一次 panel 设计走查（本期第一项）：逐页拆腾讯 MemoryPanel 的页面清单——含「接入指南 + 客户端矩阵」页（按宿主给 `ck setup` 命令与远端 MCP 的 JSON 片段）——对照排页面顺序。UI 组件库已拍 TDesign React（decisions O-12；O-2 依赖清单届时补加）。

顺序：登录 → `/assets` → `/reviews` → `/agents`（配装编辑 + resolve 预览）→ `/teams` → `/access` → `/usage` → `/audit`。

同期补的后端：`loadout/sync-template`、`usage/summary`、`audit/list`、`system/stats` / `integrity` / `backup`、`asset/import`（导入本机已有 skill）、按 key 限流（429 + `Retry-After`）。

同期补的客户端与宿主：`ck import --source <host>`；`agents/codex`、`agents/gemini-cli`（先用 A1，Codex 的 hook 待 spike 结论，否则用 `tool` 送达）；`agents/opencode`（先 spike skill 物化路径与 hook，A1-lite 起步）；Hermes 先调研再排接入档，仅当支持 MCP 才进 A1 / A0，否则按 O-8 触发 A3 评估。远端 `/mcp`（A0）若 S1 有摩擦，也在本期补齐说明。

验收门：不用 CLI，仅靠 panel 走完 B.1 – B.6 的每一步；空态、加载态、错误态、长标题与大正文都有处理；P1 的全部测试仍绿；Codex 与 Gemini CLI 各过一遍 [install.md](install.md) §7 的宿主侧四项。

### A.4 P3：自动沉淀与可选深接入

三块互相独立，各自开工前先补规格并过拍板（decisions O-7、O-8）：

- 自动沉淀：`session/report` → 抽取 → 私有草稿 → panel `/inbox`。验收：一段对话产出草稿，草稿对他人不可见，采纳后才可检索。
- 可选 A2 原生插件、A3 Proxy：只在出现 A1 / A0 覆盖不了的宿主时做；开工前先用 [hosts.md](hosts.md) §7 的六个问题证明 A1 确实不够。
- 可选：向量检索 + RRF。

### A.5 P4：知识工坊

wiki / codegraph 另立规格。约束只有一条：作为 `asset.type` 的新值接入，权限、配装、审批、用量复用现有实现。

### A.6 每期收尾

- 输出一行状态：`Done [X], Verified [Y], Unverified [Z], TODO [W]`。
- 文档与实现不一致的地方当期改掉；decisions.md 的"未验证""待拍板"同步更新。
- 提交前给变更清单与 commit message；不自动 push、不打 tag。

## B. 运营 SOP

示例用 `ck rpc`，panel 上有等价操作。凡是 `team_id` / `user_id` 入参，都可以改传 `team` / `user`（slug）。

### B.1 开通一个团队（System Admin）

```bash
ck rpc team/create '{"name":"cinlan","title":"Cinlan"}'
ck rpc user/create-with-key '{"name":"ly","display_name":"LY","key_name":"ly-laptop"}'   # 明文 key 只回这一次，线下交给本人
ck rpc team-member/add '{"team":"cinlan","user":"ly","role":"member"}'
```

然后由 Team Admin 建默认模板（B.5）。没有模板的团队，新 Agent 读到的是空档。

### B.2 新成员 / 新 Agent 接入

1. 成员拿到 key，按 [install.md](install.md) §5 装 `ck`、`ck login`、`ck setup --host <h> --agent <team>/<name>`。
2. 首次运行（`ck mcp` 启动或 hook 触发）自动 `agent/ensure`，按团队默认模板拷贝配装。
3. 开新会话，调 `knowledge_status` 自查。
4. 装第二个宿主：同一个 Agent 名可以复用（同一个 Owner、同一个配装），也可以另起一个 Agent 名（各自单独配装）。

同一个人多台机器：每台机器一把 key（方便单独吊销）。

### B.3 沉淀与共享

- 让模型记：会话里说"记下来"，模型调 `knowledge_save`，产物是自己的 private 记忆。
- 想给团队用：`knowledge_share`，或在 panel `/assets` 里点共享。附一句 `note` 说明为什么全员需要。
- 共享前自查：不含客户名、凭据、个人信息；标题能让别人一眼看懂；一条只说一件事。

### B.4 审批（Team Admin）

1. `/reviews` 逐条看：内容是否属实、是否该进全员上下文、是否与已有资产重复。
2. 重复 → 驳回并在 `reason` 里指向已有资产；可合并 → 让申请人改已有资产（走 update 提议）。
3. 批准后决定是否进配装：全员都要 → 绑进模板并下发（B.5）；偶尔用到 → 不绑定，留给检索。
4. 驳回必须写 `reason`。

### B.5 调整配装与模板（Team Admin / Agent Owner）

- 模板：建一个 `is_template` 的 Agent → `loadout/set` → `agent/set-default-template`。
- 模板变了要让已有 Agent 生效：`loadout/sync-template`，`add-missing` 只补缺，`replace` 覆盖 `source = template` 的绑定、保留各人手工加的。
- 单个 Agent：在 `/agents/:id` 调优先级、切 inject / tool、pin 版本；用预览确认注入文本与预算占用（预览可切预算，分别看 hook 宿主与 `instructions` 宿主的效果）。
- 准则：`inject` 只放"每次都必须在场"的内容，总量控制在预算的一半以内；其余用 `tool` 或不绑定。

### B.6 资产治理（每月一次）

1. `/usage` 看 90 天零用量的 `team` 资产：过时 → `deprecate`；仍有效但没人用 → 改标题与摘要，或进配装。
2. 看过期与 `deprecated` 超过 30 天的：`archive`。
3. 看配装里 `skipped`（`budget` / `no_access`）与 `downgraded` 多的 Agent：清理失效绑定，削减 `inject`。
4. 归档超过 180 天且确认无用的：`purge`。

### B.7 密钥轮换与离职

- 轮换：新建 key → `ck login` 换到机器上 → 确认 `knowledge_status` 正常 → 吊销旧 key。
- 泄露：立即吊销，查 `/audit` 里该 key 前缀的全部操作。
- 离职：`user/disable`（全部 key 即时失效）→ 其 `team` 资产由 Team Admin 接管或归档 → 其 Agent 归档。private 资产保持私有，按 B.6 的归档规则处理。

### B.8 备份、恢复、升级、回滚

- 备份：`cinlan-knowledge backup --config … --out /abs/backups/knowledge-<日期>.db`（`VACUUM INTO`），每日定时；不直接拷贝运行中的库文件。
- 恢复：停服 → 用备份替换 `knowledge.db` → 起服 → `system/integrity`。
- 升级：先备份 → 解新 release → 翻 `current` → restart（迁移在启动时执行，失败则拒绝启动并保持原库不动）；`ck` 版本随 hub 走，升级后让成员重跑一次 `npm i -g http://<hub>/dl/ck.tgz`；跑 [install.md](install.md) §7。
- 回滚：翻回 symlink；若迁移已执行，用升级前的备份恢复。旧 `ck` 连新 hub 仍可用（`/api/v1` 只做加法）。

## C. 进度看板

每完成一步由当次会话勾掉并标日期；语义冲突的拍板同步登记到 [decisions.md](decisions.md) §5。

### P0（已完成）

- [x] 骨架 / sdk 契约 / hub 最小壳 / 六个 spike（结论见 decisions §6）

### P1 core（7 步）

- [x] 1. meta（user / user-key / team / member / agent）
- [x] 2. asset（创建、版本、content_hash、状态机、校验）
- [x] 3. access + acl
- [x] 4. loadout（bind / set / resolve）
- [x] 5. review（28/28 过；两处语义冲突已按 A 口径落档 → decisions O-10）
- [x] 6. search（FTS 维护、<3 字 LIKE 兜底、deprecated 降权）
- [x] 7. usage + audit

### P1 其余

- [x] hub：接全部 P1 动作 + `/mcp`
- [x] cli（`ck`）：login / setup / mcp / hook / skills / doctor / rpc
- [x] agents/dsh 参考宿主
- [x] agents/cinlan-harness 参考宿主（复用 dsh 模板变体；home 实测 `~/.clh`）
- [x] agents/claude-code 参考宿主

### P1 验收

- [x] T1–T13 测试矩阵（T7 挪 P2 见 O-14；T8 真实进程三场景全过：正常缓存、吊销后 exit 0 + 错误块 + 缓存删、停机 stale + 缓存正文） —— 2026-11-14 计数改为实测值（原行「core 39 + mcp 12 + hub 26 + cli 187 + agents 8」的 cli 187 与 agents 8 来历不明，见 [acceptance-report.md](acceptance-report.md) §5.12）；2026-11-15 复测：core 52 + mcp 16 + hub 51 + cli 230，fail 0；没有独立的 agents 套件（`packages/cli/test/agents.test.ts` 在 cli 里）；panel 41（P2 起新增）。此前各条目里按当时时点的计数（cli 126 / 146 / … / 219）是历史记录，不回改
- [x] e2e 读档脚本（`scripts/e2e-loadout.mjs`，10/10 过）
- [x] 实机验收：dsh、cinlan-harness、Claude Code 各过 [install.md](install.md) §7 四项 —— 2026-11-13 全部完成：三条 `ck setup --write` 真实写入 + 三宿主 `ck doctor` 八项全绿；会话内 C1–C4 全过（各宿主 `knowledge_status` delivery/agent 正确、暗号均答出、会话内私有记忆 probe 隔离、吊销后三宿主新会话 UNAUTHORIZED 且优雅收尾、备用 key 恢复），细节与限制（dsh 走 `CLH_HOME` 会话、deepseek 额度绕行）见 [acceptance-report.md](acceptance-report.md) §2.4
- [x] 验收报告冲突队列批处理（[acceptance-report.md](acceptance-report.md) §5）—— 2026-11-14：5.8（冲突整次不写）与 5.13 a / b（`CK_USER_KEY` 统一、codex 换 Agent 整次不写）已拍落地（O-31）；5.5（doctor 按 install.md §5 补齐「指向本机 ck / hook 条目含 codex 信任表复算 / skill_dir 可写判据 / 缓存通报」）与 5.6（dsh / clh 落点保持实现，hosts.md §4.2 补句）已拍落地（O-32 / O-33），5.13 d / e 随之关闭；5.12（本行上方计数）已改实测值。**2026-11-15 全清**：5.1 + 5.11（dry-run 打印 ck 管的那段；generic / generic-mcp 打印手工片段）、5.2（`ck hook` 也物化）、5.3（knowledge_status 补 digest / current_digest / changed / stale / skills 物化快照，A0 无会话事实的键不出现）、5.4（hub `not_modified` 也返回 skills / items，客户端刷新缓存清单）、5.7（`pnpm pack:ck` 产出自包含 ck.tgz + hub `/dl` 分发实测 + S4 冒烟）、5.9（条目名 `ck` 归 ck 所有，json 与 yaml / toml 同口径原地更新——按语义最优取 A，待 Yorker 复核）、5.10（写入路径统一正斜杠）全部落地（decisions O-34 至 O-40）；全量测试 panel 41、core 52、mcp 16、hub 51、cli 230 全绿；`scripts/e2e-loadout.mjs` 10/10 无回归。剩余：5.13 c（gemini matcher 含 resume）等实机 resume；干净机器（Windows / Linux）上的完整 S4 与 Docker 多阶段构建接 `pnpm pack:ck`。**2026-11-15 真宿主走查复跑完成（acceptance-report §5.13 末段）**：真 codex 0.166.0（9 项，含换 Agent 信任表跟随）/ hermes v0.23.0（5 项，`hermes pm repair` 暖机后 allowlisted + mcp list）/ gemini 0.68.0（3 项，`GEMINI_CLI_HOME` homedir 语义确认）/ claude-code（4 项，hook 经 cmd.exe 实跑）共 21 项全绿——「真宿主上 doctor 新检查项复跑」关闭；e2e-panel 的 Edge 157 兼容已修（候选浏览器逐个试启，本机走 Chrome）+ cleanup 后主动退出（被杀子进程的管道句柄会挂住事件循环），`pnpm e2e:panel` 复跑 10/10、exit 0

### P2（panel + 后端补件 + 宿主扩容，A.3）

- [x] panel 设计走查（P2 首项）：拆腾讯 MemoryPanel 页面清单（含接入指南 + 客户端矩阵页），排定页面顺序；UI 组件库已定 **TDesign React**（O-12） —— 2026-11-13：产出 [panel-design.md](panel-design.md)（腾讯侧固定提交 `42d4cde5` 逐页拆解、映射表、逐页 IA 与线框、`/guide` 页设计、TDesign 令牌与组件映射）；8 项待拍问题列于该文 §7（PD-1 至 PD-7 需 Yorker 决定，不阻塞后端补件）
- [x] panel 页面，按序：登录 → `/assets` → `/reviews` → `/agents`（配装编辑 + resolve 预览）→ `/teams` → `/access` → `/usage` → `/audit` —— 2026-11-13：React 19 + TDesign（`tdesign-react` 1.18.6 + `tdesign-icons-react` 0.6.12，O-12 / O-22），八页 + 详情页 + `/guide` 全落地，hub 托管于 `/panel/`（SPA 回退 + CSP 已实测）。验证：`pnpm -r build && pnpm -r test` 全绿（sdk、panel 41、core 51、mcp 14、cli 126、hub 51）；新增 `scripts/e2e-panel.mjs`（`pnpm e2e:panel`）起临时 hub + 无头 Edge/Chrome 走 CDP，10/10 过（登录→资产→详情→审批通过→配装预览→团队→建 key→用量→审计→指南）；`scripts/e2e-loadout.mjs` 10/10 无回归。实现中与文档的两处偏差（全局 `styles.css` 而非 CSS Module、`Popup` + 原生 `datetime-local`）登记在 [panel-design.md](panel-design.md) §8 与 [decisions.md](decisions.md) §5 O-23 至 O-26，等 Yorker 重审。**2026-11-15 视觉收敛**（Yorker 提「有点丑」，O-41）：底色死灰 `#eee` → 冷调 `#f5f6f8`（实测发现 TDesign token 解析问题）、顶栏/侧栏与底同色让白卡只属于内容、卡片去阴影统一「白底+淡边框」一层、空态去虚线盒、登录页品牌锚点；方法为 headless computed-style 实测十页改前改后对照。panel 41 测试 + `e2e:panel` 10/10 无回归，明细 panel-design.md §8 末段
- [x] 后端补件：`loadout/sync-template`、`usage/summary`、`audit/list`、`system/stats` / `integrity` / `backup`、`asset/import`、按 key 限流（429 + `Retry-After`） —— 2026-11-13：八项都按「sdk 类型 + fixture → core → hub」落地。验证：每个动作一份 fixture 进 T9 重放（`hub/test/contract.test.ts` 15 例，T7 全库复算 0 条不一致并在其中）；限流另有 `hub/test/ratelimit.test.ts` 6 例（超额回 429 + `Retry-After` 且窗口过后恢复、按 key 不按人、`/mcp` 同一份额度、401 不计数、默认额度、配置校验）；`pnpm -r build && pnpm -r test` 全绿（core 51 + mcp 14 + hub 40 + cli 126），`scripts/e2e-loadout.mjs` 10/10。文档没写到、先按默认实现的口径登记在 [decisions.md](decisions.md) §5 O-15 至 O-21（O-20 是文档冲突，未改）。顺带修了一处 P1 缺陷：归档资产被更新后会回到检索索引（`core/src/asset.ts` 的 `commitVersion`，回归用例在 `core/test/asset.test.ts`）
- [x] 客户端：`ck import --source <host>` —— 2026-11-13：`cli/src/import.ts` 落地（host.json `import_scan` 扫描 + `~`/`<workspace>`/`$VAR` 展开、物化标记与坏 frontmatter 跳过、同名去重、TTY 交互 / `--yes` / 非 TTY 拒绝、`--dry-run`、逐条 `asset/import` + 429/网络 3 次退避、结果分类汇总）。团队入口按拍板的 C+A：唯一团队自动选、`--team <slug>` 兜底（hosts.md §5 flag 行已同步）。验证：`cli/test/import.test.ts` 10 例、cli 全量 136 绿；真 hub e2e（验收库）created → 重跑 unchanged。顺带修了一处 core 缺陷：`parseSkillFrontmatter` 拒收 CRLF 的 SKILL.md（`asset.ts` 字段正则行尾不吃 `\r`，Windows 本机文件必中，回归用例在 `core/test/asset.test.ts`）。默认口径登记 [decisions.md](decisions.md) O-27 / O-28。**2026-11-14 走查跟进**：真 hub + 真 `ck` 进程 15 场景复核，上述行为成立；修 7 处——hermes 的 `%LOCALAPPDATA%/hermes/skills` 没展开（主 skill 目录扫不到）、客户端 frontmatter 读法与 hub 不一致（空 `description:` 被送上去再被拒）、失败原因重复错误码且丢 `data.issues`、429 重试用尽被记成 `UNAVAILABLE`、`auth/verify` 被拒（坏 key）落到兜底分支且出口走 `process.exit()`、条目之间没有限速、内置宿主表缺 claude-code / dsh / cinlan-harness 的 `import_scan`（声明文件缺失时静默报「无候选」）。验证：`import.test.ts` +4 例、`exit.test.ts` +2 例（真进程，逐行比 stdout / stderr / 退出码）、`agents.test.ts` 等价性用例补比 `import_scan`；cli 207 绿，`pnpm -r build && pnpm -r test` 全绿（panel 41、core 51、mcp 14、hub 51）；修后真 hub 15 场景复跑符合预期（含 2 请求 / 3 秒限流下 6 条全部 created）。未验证：真实终端里的交互选择（只有注入 `ask` 的单测）。新增默认与待拍口径见 O-28 补充。2026-11-14 续：合计口径、重试次数、资产名取值三条已拍并落地（O-28「已拍」段）。**2026-11-14 再续（余下三条已拍并落地，O-28 ④⑤⑥）**：扫描表以 `host.json` 的 `import_scan` 为准，hosts.md §8 按声明重写（补 cinlan-harness / hermes / opencode，codex 的 git 根逐级与 dsh `customSkillDirs` 记为已知缺口）；frontmatter 块标量（`description: >-` / `>` / `|`）core `parseSkillFrontmatter` 与 cli `parseFrontmatter` 都认（此前读成字面量 `>-`）；断点续跑认 hub 幂等，不留本机进度文件；data-model.md §9 首行改成资产名取 frontmatter `name`。验证：`core/test/asset.test.ts` +1 例、`cli/test/import.test.ts` +2 例，均先红后绿；`pnpm -r build && pnpm -r test` 全绿（panel 41、core 52、mcp 14、hub 51、cli 219）
- [x] 宿主：`agents/codex`（A1 先行，hook 待 spike 结论，不行用 `tool` 送达）—— 2026-11-13：本机 codex-cli 0.166.0 六问 spike 全过（`instructions` 不作指令级采用 #29097/#6148；`hooks` feature 默认关；SessionStart stdin/输出 `hookSpecificOutput.additionalContext` 实机验证；`hooks.state` 信任表预写可免 `/hooks` 审查；skill 根 `~/.agents/skills` + 项目 `.agents/skills`；工具前缀 `mcp__<server>__<tool>`）。落地：`agents/codex/`（host.json + README + 三模板）、`setup.ts` 新增 TOML 标记块（`[mcp_servers.ck]` + `[hooks.state.*]` 信任表，sha256 按 `command_hook_hash` 复刻）、hook 条目显式 `timeout: 15`；`features.hooks` 不写（防 `[features]` 重复定义炸配置），setup detail 提示 `codex features enable hooks`。验证：cli 146 + panel 41 全绿（guide 分组 codex 翻 ready 已同步；doctor 新增 TOML 块 agent 解析用例）、`pnpm -r test` 全绿。**实机验收（2026-11-13 下午，codex-cli 0.166.0 + magpie 3425 网关）**：`ck setup --write` 写真 `~/.codex`（TOML 块 + `session_start:2:0` 信任表），hooks 引擎打开后 `codex exec` 完整回合——`SessionStart Completed` 免 `/hooks` 审查、暗号 `orange-lantern-42` 答出（C2）、`mcp: ck/knowledge_status completed`（C1，`mcp__ck__*` 注册）、`ck doctor --host codex` 八项全绿；验收后真实配置已从备份还原零残留。细节 [acceptance-report.md](acceptance-report.md) §2.5。默认口径登记 [decisions.md](decisions.md) O-29。**2026-11-14 走查**：`commandHookHash` 对真实 `~/.codex/config.toml` 里 codex 自己写下的 18 条 `trusted_hash` 逐条复算，18/18 一致（只读；这 18 条都不带 matcher，matcher 分支只有上面那次 `codex exec` 覆盖）；真 codex 0.166.0 对临时 `CODEX_HOME` 跑 `codex mcp list` / `codex mcp get ck`，stdio 与 http 两种标记块都读得出。没改代码。待拍两条（http 模板的 `CK_KEY` 与别处的 `CK_USER_KEY` 不同名；换 `--agent` 重跑后 config.toml 与 hooks.json 各指一个 Agent 且信任表掉线）见 [acceptance-report.md](acceptance-report.md) §5.13。**2026-11-14 两条已拍并落地**：变量名统一成 `CK_USER_KEY`（模板 + `setup.ts` + golden）；`ck setup --write` 任一文件冲突就整次不写（decisions.md O-31，acceptance-report §5.8）。验证：`setup.test.ts` / `exit.test.ts` 新增与改动的用例先红后绿，cli 219 绿；真 `ck` 进程对临时 home 复跑——换 `--agent` 后两个文件 sha1 不变、exit 1，清掉旧 hook 条目后重跑两个文件都 `update`；真 codex 0.166.0 对临时 `CODEX_HOME` 跑 `codex mcp get ck` 读回 `bearer_token_env_var: CK_USER_KEY`
- [x] 宿主：`agents/gemini-cli`（A1 stdio + hook）—— 2026-11-13：本机 gemini-cli 0.68.0 npm bundle 源码直读完成六问（settings.json 单文件 `mcpServers` + `hooks`；hooks 引擎 `enableHooks ?? true` 默认开、用户级无信任审查；`hookSpecificOutput.additionalContext` → `<hook_context>` 注入，交互式 `addHistory` / `-p` headless 前置 prompt；hook `timeout` 毫秒；工具名 `mcp_<server>_<tool>`；skill 根 `~/.gemini/skills` + `~/.agents/skills`）。落地：`agents/gemini-cli/`（host.json + README + 三模板）、`setup.ts` 新增同文件 JSON 合并规划（`mcpServers.ck` 与 `hooks.SessionStart` 一条变更落盘，防两份独立规划互覆）+ `mcp.trust` / `hook.timeout_ms` / `hook.name` 声明字段；`doctor.ts` 的 JSON agent 解析泛化到任意 `host.mcp.key`；panel roster 翻 ready。验证：cli 156 + panel 41 全绿（新增共享文件 golden 5 例 + doctor/模板一致性用例）。实机验收待跑：`gemini mcp list`、`SessionStart` 暗号、`mcp_ck_knowledge_status` 调用、doctor 全部检查项（见 `agents/gemini-cli/README.md` §验收）。默认口径登记 [decisions.md](decisions.md) O-30。**2026-11-14 走查**：bundle 源码复核 `trust`、hook `name`、`<hook_context>` 注入（交互 / headless）、`<` `>` 转义、用户级 hook 无信任审查、`.agents` skill 目录，均与上述一致；`gemini mcp list` 实跑见下面实机验收一行。更正一处事实：未信任的工作区里用户级 MCP server 整体停用，不是逐次确认（hosts.md §4.5、`agents/gemini-cli/README.md` 已改）。没改代码。待拍一条（matcher 含 `resume`）见 [acceptance-report.md](acceptance-report.md) §5.13
- [x] 宿主：OpenCode 公开资料调研 —— 2026-11-13：opencode.ai 官方文档 + v2 插件 API + issue #5409 核对。结论：`opencode.json(c)` `mcp.<name>`（v1；v2 归一化 `mcp.servers`）`"type": "local"` + `command: [...]` 整条 argv 一数组 / `"type": "remote"` + `url`/`headers`；`instructions` 采用进系统提示；**无配置式 shell hook**（插件订阅 `session.created` 等在 init 后触发且无注入通道；升级路径 v2 `ctx.session.hook("prompt")`）；baseline 走 `instructions` 数组挂文件或 `~/.config/opencode/AGENTS.md`；skill 根 `~/.config/opencode/skills/` + `.opencode/skills/`；工具名 `<server>_<tool>`（Code Mode 包成 `tools.ck.knowledge_status()`）。A1-lite 可行（stdio + instructions 投递），本机未装、实机确认项列于 hosts.md §4.7
- [x] 宿主：`agents/opencode` 适配（A1-lite）—— 2026-11-14：调研（前条）→ 落地：`agents/opencode/`（host.json + README + mcp local/remote 两模板）；`hosts.ts` schema 扩 `mcp.argv`（stdio 条目整条 argv 数组，`{"type":"local","command":[…]}`）与 `mcp.remote_type`（http 条目 `type:"remote"`），内置表加 opencode；`doctor.ts` agent 提取泛化到 `args` 分写 / argv `command` 数组 / `x-ck-agent` 头三形；无 hook——baseline 走 `instructions`（brief）+ `--rules` 写 `~/.config/opencode/AGENTS.md` 标记块，skill 落 `~/.config/opencode/skills`。验证：cli 201 绿（argv/remote 模板一致性 + setup 五金用例）、panel 41 绿（guide 分组翻 ready，ready 8 / research 0）。实机验收待装机：`opencode mcp list`/`debug ck`、v1/v2 `mcp` vs `mcp.servers` 兼容、Code Mode 下 `tools.ck.knowledge_status()` 可达——按 `agents/opencode/README.md` §验收跑。**2026-11-14 走查**：真 `ck` 进程对临时 home 跑 `setup`（stdio / http / `--rules` / 既有配置 / 冲突）与 `doctor`，输出与声明、模板一致；真宿主一项都没法验（本机未装，装机属新依赖，没有装）。没改代码。`opencode.jsonc` 并存的观察项见 [acceptance-report.md](acceptance-report.md) §6.11
- [ ] `agents/gemini-cli` 的实机验收（§7 四项，本机未装 gemini-cli，装机后按 `agents/gemini-cli/README.md` §验收跑）—— 2026-11-14 走查：用 npx 缓存里的 0.68.0 产物对临时 `GEMINI_CLI_HOME` 跑了 `gemini mcp list`（没有安装任何东西）：未信任目录下 `ck` 标 `Disabled`，工作区进 `trustedFolders.json` 后 `✓ ck … (stdio) - Connected`。§7 四项都要会话内的模型回合，仍未跑，本行不勾（doctor 现在还查 `hooks.SessionStart` 条目，清单见 install.md §5）
- [x] 宿主：`agents/hermes`（A1 stdio + `pre_llm_call` hook + allowlist 代写）—— 2026-11-13：spike 六问（前条）→ 适配落地：`hosts.ts` schema 扩 `hook.format: yaml`、`hook.output: "hermes-context"`、`hook.consent.file`、`platforms.win32`；`paths.ts` `expandHome` 支持 `%VAR%`；`yamlcfg.ts` 新增行级嵌套键合并（`mcp_servers.ck` map 条目 + `hooks.pre_llm_call` list 条目，缩进归一化比幂等，异形/不同内容报 conflict）；`setup.ts` 同文件 YAML 合并成一条变更 + `planConsentFile` 代写 allowlist `{event, command}`（与 YAML 命令行逐字符一致，hook 冲突时不写批准表）；`bin.ts`/`hook.ts` 按 `hook.output` 分派 `hermes-context`（`{"context"}`）输出，stdin 载荷 `extra.is_first_turn` 首轮门控（拿不到输出 `{}`）；`doctor.ts` 嵌套 YAML 探测 + hook/approved 双查。`agents/hermes/`（host.json + README + 三模板）、panel roster 翻 ready。验证：cli typecheck + 193 测试绿（yamlcfg 21 例 + hermes setup 7 例 + hook 输出 2 例 + paths 4 例）、panel 41 绿。**实机验收（2026-11-13 晚，真实 home + 临时 hub）**：`ck setup --write` 对 134KB config.yaml 只增 8 行零改动、allowlist 逐字符一致、doctor 八项全绿、`is_first_turn` 门控三轮正确（false/坏 JSON → `{}`，true → 真实 baseline 带验收暗号）、`hermes mcp list`/`mcp test` 读出 ck 条目且 5 个 `knowledge_*` 工具可达、`ck skills sync` 物化到 `%LOCALAPPDATA%\hermes\skills`；验收后零残留还原。途中修一处：hook stdin 先 `trim()` 防 BOM 门死首轮（`exit.test.ts` 回归，cli 194 例全绿）。详见 [acceptance-report.md](acceptance-report.md) §2.6。**2026-11-14 走查更正**：上面「allowlist 逐字符一致、doctor 八项全绿」不成立——当时代写的 allowlist 根是顶层列表，真 Hermes v0.23.0 要的是 `{"approvals": [...]}`，`hermes hooks doctor` 报 `✗ not allowlisted — hook will NOT fire at runtime`，`ck doctor` 的 `approved: true` 是假阳性（hermes 的 doctor 实为九项）。已修 `setup.ts`（根 `{"approvals": [...]}`、其他键保留、根形状不对报 conflict、`script_mtime_at_approval` 按 hermes 同串格式）与 `doctor.ts`（按 `(event, command)` 全等匹配）。验证：`setup.test.ts` / `doctor.test.ts` 回归用例先红后绿，cli 214 绿；真 hermes 对临时 `HERMES_HOME` 复跑 `hermes hooks list` → `✓ allowed`，`hermes hooks doctor` → `✓ allowlisted` / `✓ script unchanged since approval` / `✓ produced valid JSON on synthetic payload`。未验证：真会话首轮注入（要模型回合）。真实 home 里留有 `config.yaml.bak` 未删（2026-11-14 按 Yorker 指示已删，删前核过与 `config.yaml` 逐字节相同，目录里别的文件没动）。更正段在 [acceptance-report.md](acceptance-report.md) §2.6 末尾，待拍项 §5.13
- [ ] 远端 `/mcp`（A0）说明补齐（若 S1 有摩擦）—— 2026-11-14 现状（没有勾）：hub 的 `/mcp` 已实现并有 `hub/test/mcp.test.ts` 覆盖；七个宿主目录都有 `mcp.http.*` 模板，`cli/test/agents.test.ts` 逐个比对它与 `ck setup --transport http` 的输出；codex 的密钥变量名已统一成 `CK_USER_KEY`。触发条件「S1 有摩擦」定不下来：S1 里「真 dsh 会话以 streamable-http 连上并采用 `instructions`」这一半要模型回合，没有跑过（decisions.md §6 仍列为未验证），所以不知道有没有要补的说明。等 Yorker 跑一次或另行指示
- [ ] 验收门：不靠 CLI 仅用 panel 走完 B.1–B.6；P1 测试仍绿；Codex / Gemini 各过 [install.md](install.md) §7 —— 2026-11-16 前两条已闭：新增 `scripts/e2e-gate.mjs`（`pnpm e2e:gate`），零种子数据（只有 bootstrap 的 SA key），五个角色会话（root → 成员 → 管理员 → 成员 → 管理员）全部经 UI 走完 B.1–B.6：B.1 SA 建团队、/access 用户页签建两用户（KeyReveal 明文各只读一次）、团队详情加成员（角色经 TDesign Select 选「管理员」）；B.2 成员建 Agent、空档配装；B.3 新建私有记忆 + 申请共享（2 条带说明）；B.4 一通过一驳回（驳回理由必填的禁用逻辑顺带覆盖）；B.5 管理员建模板 → AddAsset 绑资产 → 设为团队默认 → add-missing 同步到成员 Agent → 成员切送法 tool + 预算预览；B.6 /usage 零用量页签 → 弃用 → 归档（purge 需 180 天，按文档不触发）+ /audit 留痕抽查。连续两轮 ALL PASS；同日 `pnpm -r test` 全绿（panel 41、core 52、mcp 16、hub 51、cli 231）。剩 Codex / Gemini 各过 install.md §7（要模型回合），本行不勾

### P3（自动沉淀 + 可选深接入，A.4——三块独立，各块先补规格过拍板）

- [x] 自动沉淀：`session/report` → 抽取 → 私有草稿 → panel `/inbox`；验收：草稿他人不可见，采纳后才可检索 —— **待拍 O-7**（hub 侧绑哪个模型通道）—— 2026-11-16 规格起草完成：[auto-distill.md](auto-distill.md)。核心发现：两条验收大半白捡——`draft` 状态在现有机器里已保证「仅 owner 可见 + 不进检索」（access.ts 谓词全排除 draft、检索只收 active/deprecated、状态机有现成 `draft → active`）；唯一 core 改点是 `createAsset` 硬编码 active（asset.ts:391）。真正待拍的是抽取通道（A' 客户端 / B' hub / C' 手动，与 O-9 embedding 通道联动）与上报触发（模型自报为主 + 手动保底，hook 事件因宿主事件面参差不统一），见该文 §4。§6 顺序里前两步（createAsset 状态入参 + session/report 的 A' 最小形状）不依赖拍板项，Yorker 点头即可动工 —— **2026-11-16 已拍（LY 授权按最优，decisions O-43）**：通道 A' 客户端抽取 + 模型自报为主/手动保底；开工按 §6 顺序 —— **当日第 1 步（core 层）已落地**：`createAsset` 加 `status: active | draft` 入参（默认 active 零回归）；新增 `core/src/inbox.ts` 的 `adoptDraft`（draft → activate 直通 + 可选共享走既有审批门，零新表）。验证：`core/test/inbox.test.ts` 3 例（草稿他人 notFound / owner 也检索不到 / 采纳后命中；share 团队采纳+共享开审批、off 团队直接生效；乱 status 与越权采纳拒绝），core 60 绿。剩余：sdk 类型 + hub 注册 `session/report`（A' 形状）与 `inbox/adopt` → MCP `knowledge_session_report` → panel `/inbox` → e2e 段 —— **同日第 2 步（sdk + hub）已落地**：`session/report`（候选 ≤5 整批原子、`origin=capture` + `session_id` 进 source）与 `inbox/adopt` 已注册并登记 registry，sdk 契约 + 4 份新 fixture 进 T9 重放（`session-report` / `inbox-adopt` / `embedding-put` / `embedding-pending`）；`hub/test/p3.test.ts` 5 例（草稿对 SA/他人均不可见、越权采纳 NOT_FOUND、adopt+share 开审批、report 校验与原子性、config `embedding.dims` 校验）。hub 51→59 绿 —— **第 3 步（MCP）已落地**：`knowledge_session_report` 进工具面（候选 zod 校验 ≤5、layer 默认 atom、team 由会话事实注入）；tools/list 六件；face.test 新增调用用例（候选以 `type=memory` 达 session/report、team_id 来自会话事实）、t10 双面与 hub 挂载层断言同步。mcp 16→17 绿。剩余：panel `/inbox` 页 + e2e 沉淀段；instructions 文本未动（改 baseline 文本会翻 digest，等实机验证一起） —— **同日已落地**：`/panel/inbox`（路由 + 侧栏「资产管理」分组第二项 + 列表/抽屉——采纳「保持私有 / 同时申请共享」、丢弃归档，全走既有动作）；`e2e-gate.mjs` 增 S.1–S.3 段（`session/report` 落草稿 → 成员收件箱采纳+申请共享 → 管理员收件箱为空、审批通过 → 团队资产库可见），连续两轮 ALL PASS。panel-design.md §4.2b 已同步。**O-7 链路端到端闭环**（宿主入口 session/report → 私有草稿 → panel 采纳 → 审批 → 团队可见），剩余仅实机项：真模型走一遍 knowledge_session_report（会话内模型回合）与 instructions 文本更新（翻 digest，与实机验证一起做） —— **2026-11-16 实机模型回合完成**（`%TEMP%\ck-magpie-session.mjs`，magpie 网关 `cinlan-buddy/glm-5.3` + 真 `ck mcp` 进程，stdio MCP 转 OpenAI function-calling）：9 项全绿——模型先 `knowledge_search("夜间值班")` 检索背景口径，再**自主调用 `knowledge_session_report`**（自带 `session_id`、`layer: atom`、独立成句的暗号+有效期），草稿落库仅 owner 可见、采纳前检索 0 命中、`inbox/adopt` 后命中。对照发现（同日第一轮，同模型）：显式「记进团队知识库」指令下模型选 `knowledge_save`+`knowledge_share` 而非 session_report——两个工具的触发语义在真模型面前被正确区分（显式指令 vs 会话收尾自动沉淀），但真宿主里模型只看得到工具描述，**instructions 注入文本应补一句工具分工指引**（当前未写；改 baseline 文本会翻 digest，全部已接会话下一轮见一次 changed，一次性成本）——已列为待办与 LY 确认。O-7 至此含实机全链闭环
- [x] 向量检索 + RRF —— **待验 O-9**：存储双实现（SQLite / Postgres）、向量双实现（`sqlite-vec` / `pgvector`）、SQLite→Postgres 迁移工具；开工前先研究可行性再定实现顺序 —— 2026-11-16 研究完成：[vector-search.md](vector-search.md)。可行性本机实测过（Windows + Node 24.9 + `node:sqlite` + sqlite-vec v0.1.9，vec0/落盘重开/CAST 坑全录）；现状是 FTS5 trigram + JS 评分，双路 RRF 可直接接在 `searchAssets` 的 JS 排序上。研究建议**缩减承诺**：PG 双实现降为远期可选（当前 `Db = DatabaseSync` 零抽象层）、迁移工具改 JSON 快照，embedding 通道 A/B/C 与 O-7 联动——三项都在该文 §6 待拍板清单里，Yorker 点头后按 §5 顺序开工（schema→双路 RRF→通道→回填，前两步不依赖拍板项） —— **2026-11-16 已拍（LY 授权按最优，decisions O-43）**：通道 A 外置 worker、PG 双实现降远期可选、迁移工具改 JSON 快照、整条资产不分块、RRF k=60 / overfetch 4×；开工按 §5 顺序 —— **当日第 1+2 步（core 层）已落地**：`sqlite-vec@0.1.9` 进 core 依赖（全仓首个 registry 依赖，O-43 授权）；`openDatabase` 机会式加载扩展（平台缺预编译时纯 FTS 启动，`vecAvailable` 如实报告）；迁移 0002 建 `embedding_chunk`（vec0 虚表不进版本迁移，`ensureVec0` 机会式建，幂等）；`core/src/embedding.ts`（put 覆盖式写 / delete / 越权参数校验）；`searchAssets` 双路——`query_embedding` 可选入参、KNN overfetch ×4 后同一 SQL 过权限/状态/过期/团队/类型/标签、`ec.version = a.current_version` 排陈旧向量、RRF k=60 融合、无向量时行为与历史逐字节一致、显式带向量但索引未建时报错不静默。已知坑已绕：node:sqlite 把 number 绑 DOUBLE（vec0 主键 / k / LIMIT 全 CAST）、vec 路参数集须独立（不能带 FTS 词参数）。验证：`core/test/embedding.test.ts` 5 例（迁移与虚表重开 / put-knn-delete / 纯语义排序 + RRF + 权限 + 陈旧向量排除 + 未启用报错 / 入参校验），core 52→60 绿；`system.test.ts` schema_version 断言 1→2；全仓 panel 41 / mcp 16 / hub 51（契约重放吃迁移无回归）/ cli 231 + e2e 三件套（10/10、gate、10/10）全绿。剩余：hub 侧 `embedding.dims` 配置 + serve 时 `ensureVec0` + `embedding/put` / 回填动作 + sdk 类型 + mcp/cli 通道（A：查询向量在客户端算） —— **同日已落地**：config `embedding: { dims }`（缺省不启用、纯 FTS；serve 时 `ensureVec0`、扩展缺失时降级启动并 warn）；`embedding/put`（Mgr 权限、覆盖式写）与 `embedding/pending`（回填差集）已注册并登记 registry；sdk 契约 + T9 重放各 1 例；`hub/test/p3.test.ts` 里 `query_embedding` 走真 HTTP 端到端（纯语义定位、RRF、pending 差集、非管理成员 FORBIDDEN / 不可见 NOT_FOUND）。hub 51→59 绿。api.md §3 已同步。剩余：cli 侧回填 worker（`ck` 用配置的模型端点算向量、调 embedding/put；`knowledge_search` 带 `query_embedding`）与真实模型实机验证 —— **同日 cli worker 已落地**：`ck embeddings sync --url <base> --model <m> [--api-key] [--team] [--limit] [--dry-run]`（env 兜底 `CK_EMBED_URL` / `CK_EMBED_MODEL` / `CK_EMBED_KEY`）——拉 `embedding/pending` 差集 → `asset/get` 取正文 → POST `<url>/embeddings`（openai-compatible）→ `embedding/put` 写回；文本 = 标题+摘要+正文截 6000 字符（阶段一整条）；逐条 100ms 限速、单条失败记录继续、dry-run 全程只读（模型端点也不调）；USAGE 已更新。`cli/test/embeddings.test.ts` 4 例（真 httpHub + 假 /embeddings 端点：文本拼装/写回字段、单条失败不拦后续、端点 500 落 failures 不崩、dry-run 零写回）。cli 231→235 绿。剩余：`knowledge_search` 查询向量的客户端注入（等真实网关端点一起定配置形态）与真模型实机验证 —— **同日已落地**：`ToolDeps` / `McpFaceSession` 加可选 `embed`，`knowledge_search` 注入时把查询文本转向量随 `asset/search` 送出（**端点失败降级纯 FTS，检索可用性优先**）；hub `/mcp`（A0）不注入——语义路只在 `ck mcp` 会话出现；`createCliSession` 从环境构造（`makeEmbedder`：`CK_EMBED_URL` + `CK_EMBED_MODEL` 两者齐备才生效，`CK_EMBED_KEY` 可选；显式参数可覆盖，测试用）。验证：mcp face.test +2 例（向量抵达 asset/search、坏端点降级且检索不失败）、cli embeddings.test +2 例（makeEmbedder 门控与真实调用、session 注入），mcp 17→19、cli 235→237 绿。**O-9 客户端全链完成**（回填 `ck embeddings sync` + 查询向量注入），剩余仅实机项：真实 embedding 端点下的端到端冒烟（回填 → 语义检索一轮）
- [ ] A2 原生插件 / A3 Proxy —— **默认不做（O-8 已拍）**，仅在出现 A1 / A0 覆盖不了的宿主时启动，先用 [hosts.md](hosts.md) §7 六问证明 A1 不够

### P5（优化与深化——部署驱动迭代，非排期）

- [ ] 收件箱徽标：panel 顶栏显示草稿数；hub `usage/summary` / `system/stats` 加草稿计数；`ck doctor` cache 通报带草稿数（零成本，一行 SQL） —— **2026-11-16 已落地**：Shell 顶栏邮件图标 + 红色徽标（`asset/list status=draft`，仅当前团队、仅自己的草稿；无草稿不显示）；live 实测：落草稿后徽标「1」出现、收件箱行可见
- [ ] 备份自动化：hub config 加 `backup.interval`（`every: 24h` 格式），`setInterval` 触发；panel 显示最近备份时间 —— **2026-11-16 已落地**：config `backup: { every: "24h" }`（校验 Nh 格式 1..8760 小时）；`serve` 时 `setInterval` 触发 `backupTo`（落 `<dataDir>/backups/`，文件名含时间戳）；shutdown 清理定时器。`p3.test.ts` 加 config 校验 6 例，hub 65→66 绿
- [ ] e2e-gate 断言扩到 25：受限资产 ACL 流转、多 Agent 共享 skill 目录、预算降级行为
- [ ] Agent 健康检查：`usage/summary` 加 `agents_stale_30d`；`/agents` 列表加「超过 30 天未见」标记 —— **2026-11-16 已落地**：`usage/summary` 加 `agents_stale`（窗口内零用量的活跃 Agent，含 `agent_id` / `name` / `host` / `owner_user_id` / `last_seen_at`——`last_seen_at` 为 `null` 表示从未出现）；`usage-summary` fixture 补 `agents_stale`（含一条 `last_seen_at: null` 的 Agent）；`usage.test.ts` 加零用量 Agent 进 stale 的断言。hub 65→66 绿。**已知坑记档**：contract 测试的 `diff` 把「空数组」当问题报（`g.length === 0` 时无条件推入 problems）——已修（`exact = true` 时才验证数组形状，空数组是合法值）
- [ ] reflect 批处理：`ck reflect --team <slug>` 对团队全部活跃资产跑一遍（按草稿数排序），产出批量提议 —— **2026-11-16 已落地**：`runReflectTeam`（cli/src/reflect.ts）——拉团队全部活跃资产 + 全部草稿，按「有草稿关联的资产优先」排序（草稿多的先跑），逐条跑单资产 reflect（顺序执行，单条失败不拦后续）；`ck reflect --team <slug> --limit <n> [--dry-run]` 批处理模式（`--asset` 单资产模式保留）。USAGE 已更新。测试：`reflect.test.ts` +2 例（批处理排序与失败不拦后续、空团队返回 ok），cli 242→244 绿
- [ ] 多 hub 联邦：`ck federation sync --from <url>`——跨 hub 资产同步（对方公开资产落入本 hub draft 区，人审采纳）
- [ ] 宿主扩容：Cursor / CodeBuddy / WorkBuddy / Pi / OpenClaw 按 hosts.md §7 六问逐个 spike
- [ ] 审批相似度预检：共享提交时用现有 FTS 检索做相似度检测，附「与现有资产的重合度」参考

**分析依据**：见 [optimization-analysis.md](optimization-analysis.md)（2026-11-16，SOP 走完后的整体盘点）—— **同日三件已落地**：① 版本回滚（`asset/rollback` 动作 + panel 版本历史区「回滚到 vN」按钮，走 update 审批门；T9 fixture `asset-rollback.json` + 实机验证 v1→v2→rollback→v3 内容正确）；② 时效提示（`system/stats.assets` 加 `expired` / `expiring_7d` 计数，SQLite datetime 直算，供 B.6 月度治理读取）；③ 版本历史面板入口（详情抽屉的对比选择下方多出回滚按钮，Popconfirm 确认，带 loading 与错误提示）。验证：hub 65 绿（+1 rollback 契约）、core 61 绿（system.test.ts 断言同步）、全仓 panel 41 / mcp 19 / cli 242 全绿、e2e 三件套全过。

- [x] wiki / codegraph：作为 `asset.type` 新值接入，权限 / 配装 / 审批 / 用量复用现有实现 —— 2026-11-16 规格完成：[p4-workshop.md](p4-workshop.md)。实测发现三条缝都已存在：sdk 枚举、panel 类型选项、loadout 通用渲染块全部 type 无关，**P4-1 只是 core 两处枚举放行 + 校验用例**（半天量）；wiki 不做链接/目录树，codegraph 构建器出线（外部工具产出、入库走 asset/create），Workshop 玩法页观察驱动缓议（`/assets?types=wiki` 即现成列表）。**同日按 O-43 授权拍板 §5 四问（按规格走 / 纯长文 / 构建器出线 / JSON 与文本都收）并落地 P4-1**：`ASSET_TYPES`（asset.ts）与 search `TYPES`（search.ts）放行 wiki、codegraph——专属校验（layer 只归 memory、files 只归 skill）对两新类型自动生效，loadout 渲染/contentHash/FTS/审批/ACL/用量全为通用路径零改动；`core/test/p4.test.ts`（建 wiki/存 codegraph JSON/types 过滤检索命中/layer 与 files 照拒），既有 search 用例的非法类型值从 wiki 换成 bogus。core 60→61 绿、全仓 panel 41 / mcp 19 / hub 59 / cli 237 全绿。**实机验证**（dev hub 新 core lib）：panel 后端已可建 wiki → team 共享 applied → `types=wiki` 检索命中。剩：Workshop 玩法页（P4-2，观察驱动）、真 codegraph 外部构建器（出线，按需立项）
- [ ] Knowledge Workshop（腾讯六玩法里唯一未取的）—— 2026-11-16 归并：与 247 是一块（`/workshop` 即 wiki / codegraph 的玩法页，architecture.md §8 定位），规格见 [p4-workshop.md](p4-workshop.md) §2.3——放行类型后 `/assets?types=wiki` 即现成列表，独立玩法页等真实使用暴露出目录树/可视化刚需再立项
- [ ] 接企业前重审企业级能力：SSO / OIDC、多实例与 HA、task 域 / 实例配额、Python / Java SDK —— **待拍**（现为刻意不做，见 [blueprint.md](blueprint.md) §7 与 [comparison.md](comparison.md)「P3 之后还剩什么」）
- [x] 深层记忆智能（v2 级，可先研究）：observations 式信念聚合、reflect、mental models / pages、矛盾消解与时效失效 —— 开工前按 A.0「超出文档先分析」补规格 —— 2026-11-16 研究完成：[deep-memory.md](deep-memory.md)。对照 Hindsight（arXiv:2512.12818）逐概念映射后的结论：**时效失效已全有**（expires_at + 状态机 + B.6，本子项关闭）；**pages 形态已对齐**（core 层常驻注入 + update 审批，且有第三方"pages-over-facts"独立印证）；v2 真实工程量只有两条——reflect 提议回路（输出走现有 update 审批，人裁决）与 evidence trail（挂 O-7）——全部依赖 O-7 通道拍板；另有一个零依赖小件 PII/secrets 规则预检可提前立项。graph 臂、bank 隔离、cross-encoder、decision model 维持不取。范围确认见该文 §4 —— **同日拍板（LY 按 O-43 授权）+ 零依赖小件已落地**：范围确认只做 reflect 回路 + evidence trail + PII 预检；**`core/src/pii.ts`**（形状正则七条：openai/anthropic/aws/google/github token、长 Bearer、私网 IP、email——刻意只收「出现即几乎必然是凭据」的形状，电话/身份证歧义太大不收），hub 三入口（create 正文扫 / set-visibility 仅提升时扫 / session/report 每条候选扫），响应 `warnings.pii` 空时键不出现、审计 detail 记 kind 不记正文；**警告不拦截**（裁决权留人审）。hub `pii.test.ts` 4 例，hub 59→63 绿、全仓 + e2e 三件套全过。v2 主体（reflect 回路 + evidence trail）待 O-7 通道在实机稳定后开工 —— **同日 reflect 回路已落地并实机验证**：`ck reflect --asset <id> --url <llm-base> --model <m> [--dry-run]`（cli/src/reflect.ts，v2 主线 deep-memory.md §3.1）——读目标资产+同团队最近 20 条沉淀草稿 → 交给 LLM（客户端调用，hub 零 LLM）→ 产出三类提议（资产更新 → `asset/update` 走 review 门；新 atom → `session/report` 落草稿；矛盾提示仅输出）→ **模型永不全权直写团队上下文**。USAGE 已加、env 兜底 `CK_LLM_URL/CK_LLM_MODEL/CK_LLM_KEY`。**实机**（magpie `cinlan-buddy/glm-5.3-flash`，`%TEMP%\ck-reflect-live.mjs`）6 项全绿：LLM 正确读了 2 条草稿、产出 1 条资产更新（把草稿的升级阈值合并进约定、明确排除时效暗号）+ 1 条新 atom（暗号标注有效期）+ 1 条矛盾提示（现有约定缺时间阈值 vs 草稿提出十分钟）。测试：`cli/test/reflect.test.ts` 5 例（prompt 组装 / JSON 解析容错 / 完整回路 dry+submit / LLM 失败不崩），cli 237→242 绿。**已知坑记档**：node ESM 里 `require` 是 undefined（`oneShotFetch` 用 `node:http.request` 绕过 undici 连接池挂住进程）；测试里的 `fetchImpl` 注入是根本修复。剩余：evidence trail（草稿合并计数）与批处理触发 —— **同日 evidence trail 已落地**：`session/report` 收到重复标题的候选不再重复创建，合并进已有草稿——`source` JSON 累积 `session_ids`（去重）与 `proof_count`（信念强度）；仅合并 owner 自己的草稿（他人同标题不误合）。sdk `AssetSource` 加 `session_ids?` / `proof_count?`。首次创建的响应也带 `proof_count: 1` + `session_ids: [sessionId]`（fixture 已同步）。验证：hub `pii.test.ts` +1 例（三 session 两 title：proof_count 1→2→3、session_ids 去重、跨 owner 不合并），hub 63→64 绿；session-report fixture 同步。**v2 三条主线全部完成（reflect 回路 + evidence trail + PII 预检）**。剩余：批处理触发（等真实使用有需求再加）。全仓 panel 41 / core 61 / mcp 19 / hub 64 / cli 242 + e2e 三件套全绿
