# 配装与读档规范（Loadout）

配装 = **固定绑定 + ACL**（腾讯的定义）：先按 Team / User / Agent / 可见性把范围收窄，再决定注入什么、按需检索什么。本文规定解析算法、文本格式、读档怎么送达宿主、工具、`ck` 运行时与缓存、skill 物化。各宿主的配置写法在 [hosts.md](hosts.md)。

## 1. 三种消费方式

| 方式 | 适用 | 触发 |
| --- | --- | --- |
| 固定注入（`injection_mode = inject`） | `core` / `profile` 层记忆、必须时刻生效的约定 | 会话开始，一次 |
| 目录 + 按需打开（`injection_mode = tool`） | 篇幅大或只偶尔用到的资产 | 注入一行摘要，模型用 `knowledge_open` 取全文 |
| 检索（不绑定） | `atom` 层记忆、其余一切可读资产 | 模型调 `knowledge_search` |

`atom` 不逐轮自动注入。理由同腾讯 Proxy 的做法（它的 L1 原子记忆经工具按需暴露）：每轮改写上文会破坏上游 KV cache。

## 2. `loadout/resolve` 算法

```
resolve(agent, { if_digest, budget_chars = 12000, max_bytes, max_items = 30 })

1. 身份     agent → owner user → 团队成员关系
2. 取绑定   agent_asset JOIN asset，ORDER BY priority, created_at, asset_id
3. 收窄     逐条 canRead(principal, asset)，且 status = active、未过期
            不通过的记入 skipped[]（reason: no_access | not_active | expired）
4. 定版     pin_version ?? current_version
5. 去重     同名 skill 只留排在最前的一条，其余记 skipped[]（reason: name_conflict）
6. 分组     inject + memory → <core> 段（全文）
            inject + skill  → <skills> 段（name + summary），并进 skills[] 物化清单
            tool  + 任意    → <catalog> 段（id + title + 摘要前 80 字符）
7. 预算     两个上限同时生效：budget_chars（字符数）与 max_bytes（UTF-8 字节，缺省不限）
            外框、说明行、<tools> 段的固定开销先计入
            a) inject 项按顺序逐条试放：放得下且未到 max_items → 进 <core> / <skills>；
               否则降级为目录行（downgraded = true），继续试下一条
            b) 目录行（tool 项 + 降级项）按顺序逐行试放：放不下或已满 50 行 →
               不进文本，记 skipped[]（reason: budget）
            不截断任何一条：要么整条进，要么整条不进
8. 渲染     生成 text；digest = sha256(text)
9. 短路     if_digest = digest → { not_modified: true }
```

两个上限各管一件事：

- `budget_chars` 控制上下文占用。用字符数而不是 token：确定、可测、与模型无关。
- `max_bytes` 对付宿主的硬上限。dsh 对 MCP `instructions` 按 UTF-8 字节封顶，超限的后果是连接失败（工具全丢）而不是截断；中文一个字符占 3 字节，只数字符挡不住。

两个值都由调用方按宿主声明传入（`agents/<host>/host.json`）。hub 不认识宿主，只执行上限。

排序稳定性是硬要求：同样的绑定与内容必须产出逐字节相同的 text，否则 digest 失去意义。

`skills[]` 列出全部通过收窄与去重的 `inject` 型 skill，不受预算影响：预算只决定它在文本里出现在 `<skills>` 还是 `<catalog>`，不决定是否物化。

## 3. 文本格式

完整配装文本（`loadout/resolve` 的 `text`）：

```
<cinlan_knowledge team="cinlan" agent="dsh-ly" digest="9f2c…">
以下是团队记忆中枢为本 Agent 配装的内容。<core> 是必须遵守的团队约定；<catalog> 与其他记忆按需用工具取。

<core>
## 发版检查清单  (ast_5a01…  v3)
发布前先跑 e2e，再翻 symlink current；回滚 = symlink 翻回。

## 旧认证模块禁区  (ast_77b2…  v1)
不要重构 legacy auth，移动端仍在用。
</core>

<skills>
- deploy-release —— 发版与回滚的操作步骤
</skills>

<catalog>
- ast_c3d4…  接口错误码总表 —— 全量枚举与含义
</catalog>

<tools>
knowledge_search 查团队与个人记忆；knowledge_open 取全文；knowledge_save 记下值得留存的结论（默认仅自己可见）；knowledge_share 申请共享给团队。
</tools>
</cinlan_knowledge>
```

规则：

- 文本只在 hub 生成。客户端不拼接、不裁剪、不改写。
- 渲染时对正文里出现的框架标签（`cinlan_knowledge*`、`core`、`skills`、`catalog`、`tools`）做转义。资产正文不能伪造或提前闭合外框。
- 文本里只写工具原名（`knowledge_search`），不写宿主加的前缀。

客户端自己产生的固定文本只有三种，都不含资产内容，模板集中在 `packages/mcp` 一处：

引导语 `brief`（≤ 1,500 字符，放 MCP `instructions`）：

```
<cinlan_knowledge_brief team="cinlan" agent="cc-ly">
本会话接入了团队记忆中枢（MCP server：ck）。
- 上下文里没有 <cinlan_knowledge> 块时，先调用 knowledge_status（reload: true）读取团队配装。
- 涉及团队约定、流程、历史结论时，先 knowledge_search，再用 knowledge_open 取全文。
- 值得留存的结论用 knowledge_save（默认仅自己可见）；要给团队用，再 knowledge_share。
</cinlan_knowledge_brief>
```

错误提示（读档失败时代替配装文本）：

```
<cinlan_knowledge error="UNAUTHORIZED">
团队记忆中枢本次读档失败：UNAUTHORIZED。团队配装未加载；调用 knowledge_status 查看原因。
</cinlan_knowledge>
```

缓存提示（用缓存兜底时，加在原样输出的缓存文本之前）：

```
<cinlan_knowledge_notice stale="true" fetched_at="2026-11-12T03:00:00Z">hub 暂不可达，以下配装来自本机缓存。</cinlan_knowledge_notice>
```

## 4. 读档投递

同一份文本，三种送法：

| 方式 | 怎么送 | 落在哪 | 何时刷新 | 上下文压缩之后 |
| --- | --- | --- | --- | --- |
| `hook` | `ck hook session-start` 向 stdout 输出宿主格式的 JSON（如 `hookSpecificOutput.additionalContext`） | 会话上下文，位置由宿主定 | 每次 hook 触发 | 宿主在压缩后重跑 hook 才恢复（Claude Code 的 matcher 里带 `compact`） |
| `instructions` | MCP `initialize` 结果里的 `instructions` 字段 | 系统提示 | 每次建立 MCP 连接 | 不受影响 |
| `tool` | 模型调 `knowledge_status {reload: true}`，文本在工具结果里 | 工具结果 | 每次调用 | 随历史被压缩；靠 `brief` 或规则文件里的那一行让模型重新调用 |

`instructions` 有两种形态：

- `brief`（默认）：§3 的引导语。任何宿主都放得下，包括 Claude Code 旧版的 2,048 字符上限。
- `full`：完整配装文本，解析时带 `max_bytes = 24000`。只给"把 `instructions` 原文放进系统提示、且上限够大"的宿主。

每种送法的预算（值写在 `agents/<host>/host.json`，下表是 P1 两个参考宿主与通用默认）：

| 送法 | `budget_chars` | `max_bytes` | 依据 |
| --- | --- | --- | --- |
| `instructions full`（dsh） | 12,000 | 24,000 | dsh 默认上限 32,768 字节，超限连接失败；留四分之一余量 |
| `hook`（Claude Code） | 8,000 | — | Claude Code 把超过 10,000 字符的 hook 输出改存文件，只留 2,000 字符预览；JSON 转义会让输出比文本长，留两成余量 |
| `tool` | 12,000 | — | 工具结果没有上述硬上限 |

规则：

1. **一个宿主只启用一种完整投递**（`hook` 或 `instructions full`）。`brief` 可以与 `hook` 并存：hook 没跑成时，它是让模型自己去取的后手。各宿主的默认组合见 [hosts.md](hosts.md) §3。
2. **baseline 是会话级快照**。会话中途配装变了不重新注入：`knowledge_status` 会报 `baseline.changed = true`，新会话（或重连 MCP）生效。
3. **不逐轮注入**（§1）。
4. **不截断**。hook 的 JSON 编码后超过宿主上限时，本次改投 `brief` 加一句"请调用 `knowledge_status`（`reload: true`）"，不输出半截文本。
5. **失败可见**。`ck hook` 永远以 0 退出，不拖垮宿主会话；读档失败时输出 §3 的错误提示块，模型与人都看得到。`ck mcp` 读档失败时照常提供工具，`instructions` 里放错误提示。
6. **吊销即失效**。`401 / 403 / 404` 时不用缓存、不注入任何资产内容（§6）。

## 5. 工具

五个，定义在 `packages/mcp`，hub 的 `/mcp` 与 `ck mcp` 挂的是同一份。MCP server 名统一为 `ck`，工具原名不带前缀；宿主各自加的前缀见 [hosts.md](hosts.md) §3。

| 工具 | 入参 | 返回 | 对应动作 |
| --- | --- | --- | --- |
| `knowledge_search` | `query`，`types?`，`tags?`，`limit?`（默认 8，≤ 20） | `hits[]`：`id, type, title, summary, snippet, score, version, visibility, owner, deprecated` | `asset/search` |
| `knowledge_open` | `id`，`path?`（skill 的附属文件） | `id, type, title, version, content`；skill 另带 `files[]`（路径与大小） | `asset/get` |
| `knowledge_save` | `title`，`content`，`tags?`，`layer?`（默认 `atom`）；改自己已有的：`id` + `base_version` | `id, version, visibility: "private"`；冲突时 `VERSION_CONFLICT` + `current_version` | `asset/create` / `asset/update` |
| `knowledge_share` | `id`，`visibility`（`team` / `restricted`），`note` | `status: "applied"` 或 `"pending_review"` + `review_id` | `asset/set-visibility` |
| `knowledge_status` | `reload?`（默认 `false`） | hub 连通性、user、team、agent、host；`baseline`（`delivery, digest, current_digest, changed, stale`）；配装摘要（`items, downgraded, skipped[]`）；skill 物化结果与冲突；我的审批单；`reload: true` 时另带完整配装 `text` | `auth/verify` + `loadout/resolve` + `review/list` |

- 检索范围 = 该 principal 的可读集合（本人资产 + 所在团队的 `team` 资产 + ACL 命中 + 绑定到本 Agent 的 `agent` 资产），先收窄再排序。
- `knowledge_save` 只创建 `memory`；skill 的创建与修改走 panel、`ck rpc` 或 `ck import`。
- 结果是一段 JSON 文本。出错时 MCP 结果带 `isError: true`，文本以 hub 的错误枚举开头（`VERSION_CONFLICT: …`），不吞错、不改写成别的错误。
- 每个工具的 description ≤ 400 字符：Claude Code 对 MCP 工具描述有字符上限（默认 4,096，旧版 2,048），超出部分会被截掉。
- `knowledge_status` 是排错入口，任何状态下都必须能调：hub 不可达、key 失效、Agent 不存在时，它返回的是明确的原因，不是失败。
- 经远端 `/mcp`（A0 接入）调用时没有本机状态：`baseline.changed` 与 skill 物化结果不出现。

## 6. `ck` 运行时与缓存

`ck mcp`（启动时）与 `ck hook session-start` 走同一个 `prepare()`：

```
prepare({ host, agent: "<team>/<name>" })
  1. 配置    hub 地址与 key：环境变量 CK_HUB_URL / CK_USER_KEY 优先，其次 ~/.cinlan-knowledge/{config.json, key}
  2. 身份    agent/ensure {team, name, host} → agent_id
  3. 解析    loadout/resolve {agent_id, if_digest: 缓存的 digest, budget_chars, max_bytes}   预算取自 host.json
  4. 缓存    成功 → 原子写 cache/loadout-<agent_id>.json
  5. 物化    skills[] 差量写入宿主的 skill 目录（§7）
```

之后各自输出：`hook` 打印宿主格式的 JSON；`mcp` 在 `initialize` 结果里给 `instructions`，然后常驻提供工具。两者都会物化 skill（`mcp` 后台做、`hook` 输出后做，各限 10 秒；失败记日志不拦文本，下次启动续做）。文本送出后上报一次 `usage/report`（`injected`）。

约束：

- **时限**。步骤 2–3 合计 3 秒（`CK_TIMEOUT_MS` 可调），超时按网络故障处理。物化另计 10 秒，超时不影响文本投递，下次启动续做。
- **幂等**。dsh 的 stdio 协商会先起一个临时探测进程再起正式进程；Claude Code 的 hook 与 MCP 进程同时启动。同一时刻可能有多个 `prepare()` 在跑：缓存与物化都用"临时文件 / 目录 + rename"，改名时发现目标已是同一 `content_hash` 视为成功；同一 Agent 同一 digest 的 `injected` 上报 60 秒内只发一次。
- **stdout 是协议通道**。`mcp` 与 `hook` 两个子命令不往 stdout 写任何别的东西。日志写 `~/.cinlan-knowledge/logs/`，不含 key 与正文。
- **key**。`ck login` 从 stdin 读 key（不走命令行参数，避免进 shell 历史与进程列表），校验通过后写入 `~/.cinlan-knowledge/key`（POSIX 下 0600；Windows 下依赖用户目录的 ACL）。key 不写进任何宿主配置。

缓存规则：

| 情况 | 行为 |
| --- | --- |
| 解析成功 | 用新文本；写缓存 |
| `not_modified` | 用缓存文本（digest 相同即逐字节相同）；清单（items / skills）取本次应答，与缓存不同时刷新缓存——skill 升版本不改文本，物化清单要靠它拿到新版本（2026-11-14 拍板） |
| 网络错误 / 超时 / `5xx` | 有缓存 → 原样输出并加缓存提示，`stale: true`；没有缓存 → 错误提示 |
| `401 / 403 / 404` | 不用缓存，并删除该 Agent 的缓存文件；输出错误提示 |

- 缓存文件：`{ digest, text, items, skills, fetched_at }`。只缓存 baseline；`knowledge_status {reload: true}` 永远在线取。
- key 被吊销、用户被禁用、Agent 被归档之后，本机缓存不能继续充当读档来源：这是上表最后一行存在的理由。
- 没有双向同步，没有 tombstone，没有冲突副本。本机不存在"我的版本"。

## 7. skill 物化

`inject` 型 skill 写进宿主的**用户级**原生 skill 目录，由宿主自己的 skill 机制发现与加载：

| 宿主 | 目录 |
| --- | --- |
| dsh、Codex CLI、Gemini CLI | `~/.agents/skills/<name>/` |
| Claude Code | `~/.claude/skills/<name>/` |

目录取自 `host.json`，依据见 [hosts.md](hosts.md) §3。

```
<skill 根>/
  <name>/
    SKILL.md
    …附属文件
    .cinlan-knowledge.json     { asset_id, version, content_hash, agents: ["agt_…"], materialized_at }
```

规则：

- **平铺**。宿主的 skill 发现只下探一层（`<根>/<name>/SKILL.md`），不按团队或层级嵌套。
- **只动带标记的目录**。同名目录没有标记文件 → 跳过并在 `knowledge_status` 报冲突，不覆盖本机手写的 skill。标记里的 `asset_id` 与要写的不同（另一个团队的同名 skill）→ 同样不覆盖、报冲突。
- **引用计数**。同一台机器上几个 Agent（如 `dsh-ly` 与 `codex-ly`）可能共用 `~/.agents/skills`：标记里的 `agents[]` 记录谁在用。某个 Agent 的 `skills[]` 里不再有它 → 只把自己从 `agents[]` 里去掉；`agents[]` 空了才删目录。
- **版本分歧**。两个 Agent 把同一个 skill 钉在不同版本：目录只有一份，取版本号大的，并在 `knowledge_status` 提示。
- **原子写**。先写同级临时目录再整体改名；`content_hash` 相同则跳过。
- **路径二次校验**。hub 入库时已校验，`ck` 落盘前再校验一遍：相对路径、无 `..`、无盘符，解析后的落点必须在目标目录内。
- **只写用户级目录**，不往项目目录里写，不污染仓库。
- **frontmatter**。skill 入库时 hub 校验 `SKILL.md` 以 YAML frontmatter 开头，`name` 等于资产的 `name`，`description` 非空（单行标量或块标量 `>` / `|`；折叠标量按折叠后的文本算）。dsh 对缺这两个字段的 skill 直接忽略（`skill-filesystem/src/index.ts`），其他宿主同样靠它们做发现。
- **生效时机**。Claude Code 对 `~/.claude/skills` 有热加载，`SessionStart` hook 还可以返回 `reloadSkills: true` 让本会话立即可见。其他宿主是否需要重启未验证，列入 P0 spike（[sop.md](sop.md) §A.1 的 S5）。

skill 是可执行内容，物化等于往成员机器上分发它。控制点在 hub 侧：谁能绑定、共享是否过审、是否钉版本，见 [architecture.md](architecture.md) §10。

## 8. 更深的接入（可选，P3）

接入等级见 [hosts.md](hosts.md) §2。A1（`ck`）覆盖不了的才往下走，开工前先写明缺的是什么。

### 8.1 A2 原生插件

用宿主自己的插件机制，在进程内完成读档与工具注册。以 dsh 为例，可行的挂点已在源码里确认：`agent/pre-step` 事件 + `createUserMessage({ content, source })`，自定义 `source.kind` 通过 `MessageSourceMap` 模块扩充注册（`packages/core/agent/src/runtime-types.ts`、`packages/context/agent-instructions/src/state.ts`）。

A1 给不了、A2 才有的东西：会话进行中刷新 baseline、宿主 UI 里的集成、不依赖本机 Node。代价是每个宿主一套代码与一条安装链路。目前没有需求指向它。

### 8.2 A3 Proxy

只给既无 MCP 也无 hook 的宿主。阶段对照腾讯 MemoryProxy 的流水线：

| 腾讯阶段 | 我们的实现 |
| --- | --- |
| auth → systemUser | Bearer User Key → principal |
| sessionInit（表单选 team → agent → task；可用 `x-team-id` / `x-agent-id` 预选） | 请求头 `x-ck-agent`，按 ensure 语义解析 |
| injection | 调 `loadout/resolve`，文本并入 system |
| rateLimit → forward | 按 key 限流，直通上游 |
| extract → report | `session/report`（L0 对话层），异步抽取 |

注入计划在 hub 侧生成，所以加 Proxy 只是多一个调用方，注入逻辑不重写。

## 9. 自动沉淀（P3）

```
会话结束类 hook（Claude Code 的 SessionEnd / Stop；Codex、Gemini CLI 有同类事件）
        → ck hook session-end → session/report {session_id, turns[]} → session_turn（L0 对话层，保留 30 天）
        → 抽取任务（hub 侧 LLM 绑定）→ 产出 atom 草稿：status = draft, visibility = private, owner = 该 user
        → Owner 在 panel /inbox 逐条：采纳（activate）/ 修改 / 丢弃
        → 想给团队用，再走共享审批
```

自动产物永远落在 Owner 的私有草稿里，到不了团队上下文，除非人显式采纳并共享。这是对"模型直写无门"的回答。默认关闭，按 Agent 开启。腾讯用 Proxy 做全量对话采集；我们用宿主的 hook 做，采得到的范围以各宿主 hook 提供的会话记录为准，P3 开工时逐个宿主确认。
