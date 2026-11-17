# cinlan-knowledge 架构

## 1. 定位与边界

团队 Agent 的记忆中枢：一个 hub 服务登记全部**记忆资产**，按 Team / User / Agent 做权限，按 Agent 做**配装**；各种 agent harness 与 agent CLI（dsh、Claude Code、Codex CLI、Gemini CLI 等）在会话开始时"读档"。

- hub 是唯一事实源。客户端没有同步引擎，只有配装结果的本机缓存。
- 多宿主是一等目标。运行面只依赖宿主的公共能力（MCP、会话开始 hook、原生 skill 目录），不依赖任何一个宿主的私有插件接口。
- 管资产的登记、权限、配装、治理；不代理 LLM 流量，不做对话编排。
- v1 资产类型：`memory`、`skill`。`wiki` / `codegraph` 只留类型位，P4 实现。

## 2. 组件

```
  管理面                        运行面（宿主所在的机器）
  panel ───sdk──┐               宿主 ──stdio MCP──▶ ck mcp  ──sdk──┐
  ck rpc ──sdk──┤               宿主 ──会话 hook──▶ ck hook ──sdk──┤
                │               宿主 ──Streamable HTTP（A0）───────┤
                ▼                                                  ▼
        ┌───────────────────────── hub ──────────────────────────────┐
        │  /api/v1/<域>/<动作>      /mcp       /panel      /dl         │
        │            └──── 动作注册表 ───┘                             │
        ├───────────────────────── core ─────────────────────────────┤
        │  meta │ asset │ access │ loadout │ review │ search │ usage │ audit
        ├────────────────────────────────────────────────────────────┤
        │  SQLite 单文件（关系 + 版本 + FTS5）                          │
        └────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 | 不做 |
| --- | --- | --- |
| `core` | 领域内核：meta（user / key / team / member / agent）、asset（版本、状态机、hash）、access（权限判定）、loadout（绑定、模板、解析）、review、search、usage、audit | 不碰 HTTP；不读配置文件；不做渲染以外的展示逻辑 |
| `hub` | HTTP 壳：动作注册表、User Key 认证、入参校验、统一信封；`/mcp`（把 `mcp` 包挂到动作注册表上）；托管 panel 静态资源与 `ck` 安装包；CLI（`serve` / `bootstrap` / `backup`） | 不含业务判断（全部委托 core） |
| `sdk` | 契约类型、错误枚举、fixture、TS client（fetch，零依赖） | 不含业务逻辑；不缓存 |
| `mcp` | MCP 面的唯一实现：五个工具的定义、`instructions` 的生成、固定引导语模板。对一个 `Rpc` 接口编程，不关心背后是进程内分发还是 HTTP。全仓库只有它 import MCP SDK | 不含权限与预算逻辑（都在动作里） |
| `cli`（`ck`） | 宿主所在机器上唯一的可执行文件：`login` / `setup` / `mcp` / `hook` / `skills` / `import` / `doctor` / `rpc` | 不实现权限；不拼配装文本；不写宿主分支（宿主差异读 `agents/<host>/host.json`） |
| `panel` | 控制台 SPA | 零后端逻辑，只调 sdk |
| `agents/<host>` | 每个宿主一份声明（`host.json`）、配置模板、接入手册 | 不放业务代码 |

与腾讯的对应：

| 我们 | 腾讯 | 差异 |
| --- | --- | --- |
| `core` + `hub` | MemoryCore（gateway :8420：L0–L3 / skill / meta）+ MemoryPanel 的后端 | 合成一个进程一个端口 |
| `panel` | MemoryPanel（:8125） | 模块对应其六个玩法，另加审批页 |
| `/mcp` + `mcp` 包 | MemoryKnowledge 的 MCP server、`/v3/tools/list` + `/v3/tools/call` | 我们把 MCP 当运行面主通道；只出同一套 5 个工具 |
| `ck` + `agents/<host>` | MemoryProxy（:8096，7 类客户端适配器）+ `agents/setup-proxy.sh` + `agents/asset-import.ts` | 不站在 LLM 流量路径上；每个宿主的适配是声明与模板，见 §5 |
| P4 知识工坊 | MemoryKnowledge（:8424：Wiki + CodeGraph） | 后置 |
| `sdk` | `sdk/memory-core/{python,typescript}` | 只做 TS |
| `deploy` | `deploy/panel-knowledge-combined` | 单镜像单端口 |

## 3. 领域模型速览

```
User ─┬─ UserKey*
      ├─ TeamMember(role) ── Team ── template Agent
      └─ Agent* ── AgentAsset*(priority, injection_mode, pin_version) ──▶ Asset
Asset ── AssetVersion* ── AssetFile*          Asset ── ACL*          Asset ── Review*
```

字段、枚举、权限矩阵、状态机见 [data-model.md](data-model.md)。

## 4. 四条主流程

### 4.1 读档（新 Agent 接入 / 每个会话开始）

```
一次性（每台机器、每个宿主）
  ck login                                      key 写入本机，不进宿主配置
  ck setup --host <h> --agent <team>/<name>     往宿主配置里写 MCP 条目与会话开始 hook 条目

每个会话开始（宿主拉起 ck）
  → agent/ensure {team, name, host}             首次创建：拷贝团队默认模板的配装
  → loadout/resolve {agent_id, if_digest, budget_chars, max_bytes}
       core：权限收窄 → 绑定按 priority 排序 → 预算 → 渲染文本 + digest
  → 文本送达：hook 的 additionalContext，或 MCP 的 instructions（按宿主声明二选一）
  → skill 类资产物化到宿主的原生 skill 目录，由宿主自己的 skill 机制接管
  → usage/report（injected）
```

A0（宿主直连远端 `/mcp`）没有本机步骤：`initialize` 时 hub 按请求头完成 ensure 与 resolve，文本放在 `instructions` 里；没有 skill 物化。送达方式、预算、失败与缓存规则见 [loadout.md](loadout.md) §4、§6。

### 4.2 沉淀（Agent 写记忆）

```
模型调 knowledge_save {title, content, tags}
  → asset/create：owner = 当前 user，visibility = private，version = 1
  → 本人的任意 Agent（不论哪个宿主）之后可检索命中；其他人不可见
```

### 4.3 共享（提升可见性）

```
knowledge_share {id, visibility: "team", note}   或 panel 上点"共享到团队"
  → asset/set-visibility
       团队 review_mode = off，或申请人是 Team Admin 且允许自批 → 直接生效（仍留审批记录）
       否则 → review(pending)，返回 pending_review
  → Team Admin 在 /reviews 看内容与 diff → review/decide approve | reject（reject 必填 reason）
  → approve：同一事务内改可见性 / 推进版本指针 + 写 audit
```

共享过审的理由：`team` 可见的内容等于往所有成员 Agent 的上下文里写字，审批是这条注入面的安全控制。

### 4.4 配装

```
Agent Owner 或 Team Admin 在 /agents/:id 编辑
  → loadout/set [{asset_id, priority, injection_mode, pin_version?}]
团队默认模板：agent/set-default-template；新成员 agent/ensure 时拷贝
模板更新后要下发：loadout/sync-template {mode: add-missing | replace}（显式动作，留审计）
```

## 5. 运行面通道

接入等级 A0–A3 的定义见 [hosts.md](hosts.md) §2。

| 通道 | 做法 | 好处 | 代价 | 定位 |
| --- | --- | --- | --- | --- |
| MCP + `ck`（A1） | 宿主配置里一条 stdio MCP 条目、一条会话开始 hook，都指向 `ck` | 一套实现覆盖所有支持 MCP 的宿主；不经手 LLM 流量与模型密钥；key 不进宿主配置；能物化 skill | 每台机器装一次 `ck`（Node ≥ 20） | **P1 主通道** |
| 远端 MCP（A0） | 宿主直连 hub 的 `/mcp` | 零安装 | key 落在宿主配置里；读档效果取决于宿主怎么用 `instructions`；没有 skill 物化 | P1，装不了 `ck` 时用 |
| 原生插件（A2） | 用宿主私有的插件接口在进程内集成 | 宿主内的深度集成 | 每个宿主一套代码与一条安装链路 | P3 可选 |
| Proxy（A3） | 腾讯做法：宿主改 `baseURL`，代理里做注入与抽取 | 宿主零感知；能采集全量对话 | 每个宿主一个协议适配器；要实现协议直通、SSE、代理内工具循环；成为全部 LLM 流量与模型密钥的单点 | P3 可选，只给既无 MCP 也无 hook 的宿主 |

腾讯靠 Proxy 兼容 7 类客户端，每接一个要实现 11 项能力（`agents/adapter-agent-development.md`）。我们的目标相同——一个中枢、多种宿主——手段不同：已核对的四个宿主（dsh、Claude Code、Codex CLI、Gemini CLI）都有 MCP 与原生 skill 目录，也都有会话开始 hook（dsh 的是实验性桥接，所以它改用 MCP `instructions`）。这三样公共能力足以完成"读档 + 工具 + skill 分发"，不必站到 LLM 流量路径上。逐项对照与各宿主的证据见 [hosts.md](hosts.md) §1、§3。

三个关键设计：

1. **注入计划在 hub 侧生成**。`loadout/resolve` 返回渲染好的文本与 digest，所有通道都是薄客户端。以后加 Proxy 只是多一个调用方，注入逻辑不重写。
2. **MCP 面只实现一次**。`mcp` 包对 `Rpc` 接口编程：hub 的 `/mcp` 给它进程内分发，`ck mcp` 给它 HTTP client。A0 与 A1 因此是同一份工具定义、同一份文本。
3. **宿主差异是数据，不是代码**。配置文件位置与格式、用哪种送达方式、预算、hook 输出形状、skill 目录都写在 `agents/<host>/host.json`；`ck` 读声明，不写宿主分支。新增一个宿主 = 回答六个问题并交一份声明（[hosts.md](hosts.md) §7）。

## 6. hub

- Node `http`，零框架。业务路由 `POST /api/v1/<域>/<动作>` → 动作注册表 `Map<string, ActionDef>`。`ActionDef = { input, agent: 'required' | 'optional' | 'none', handler }`。
- `POST /mcp`：MCP 的 Streamable HTTP，无状态——每个请求自带身份，不发会话 id，不开服务端推送流。工具调用经进程内 `Rpc` 落到同一张动作注册表，校验、权限、审计与 `/api/v1` 完全相同。
- `GET` 只有 `/healthz`（仅 `{ ok }`）、`/panel/*`（静态资源，SPA fallback）、`/dl/*`（`ck` 安装包与其 sha256；不含密钥，免认证）、`/`（302 到 `/panel/`）。
- 认证：`Authorization: Bearer <user-key>` → 按 key 前缀查 `user_key` → `timingSafeEqual` 比摘要 → 检查吊销 / 过期 / 用户状态 → principal。hub 只认 User Key；401 响应不带 OAuth 元数据。
- Agent 身份：`/api/v1` 用 `x-ck-agent-id`；`/mcp` 另接受 `x-ck-agent: <team>/<name>`，按 `agent/ensure` 语义解析。两者都校验该 Agent 属于此 user 且 active。
- `Origin` 校验：请求带 `Origin` 头且不在 `listen.allowedOrigins`（默认只有 hub 自己的源）→ 403。认证只认 `Authorization` 头，不用 cookie。
- 每请求一行 JSON 日志：`request_id / action / user / agent / host / code / ms`，不记 body。
- 约定与动作目录见 [api.md](api.md)。

## 7. core

```
core/src/
  db.ts            node:sqlite 适配层（唯一 import node:sqlite 的文件）；migrations/
  ids.ts  hash.ts  id 生成；contentHash（全系统只有这一份）
  meta/            user, user-key, team, member, agent
  asset/           asset, version, file；状态机
  access.ts        canRead / canManage / accessibleSql —— 检索、打开、配装、列表共用
  loadout/         bindings, template, resolve（预算 + 渲染 + digest）
  review/          share / update / retire 申请与裁决
  search.ts        FTS5(trigram) + 短词 LIKE 兜底
  usage.ts  audit.ts
```

并发模型：单进程 + 同步 SQLite。一个动作的读-改-写在同一个同步事务里完成，中间不 `await`。这条规则替代了 demo 里缺失的写互斥。

## 8. panel

React SPA，构建产物由 hub 托管。登录 = 输入 User Key（存 sessionStorage）→ `auth/verify`。

| 路由 | 腾讯玩法 | 内容 | 期 |
| --- | --- | --- | --- |
| `/assets` | Asset Library | 资产库：类型 / 可见性 / 状态 / Owner / 标签过滤；详情 = 正文、版本历史 diff、被哪些 Agent 绑定、用量 | P2 |
| `/agents` `/agents/:id` | Agent Loadout | Agent 列表（含宿主）；配装编辑：优先级、inject / tool、pin 版本、预算占用、resolve 文本预览（预算可调，用来看不同宿主下的效果） | P2 |
| `/teams` `/teams/:id` | Team Up | 成员与角色、团队策略（review_mode）、默认模板 | P2 |
| `/reviews` | —（我们加的） | 待审队列：share / update 申请、diff、approve / reject | P2 |
| `/access` | Access Control | 资产 ACL、我的 key；System Admin 的用户与 key 管理 | P2 |
| `/usage` | Asset Usage Analytics | 热 / 冷资产、按 Agent 与按宿主的用量、从未被用过的资产 | P2 |
| `/audit` | — | 审计日志 | P2 |
| `/guide` | 接入指南 | 三步接入、客户端矩阵、我的 key、导入本机 skill、排错；纯前端，只调 `auth/verify` 与现有 key 动作，片段取自构建时打进静态资源的 `hosts.json` | P2 |
| `/inbox` | — | 自动沉淀的草稿待整理 | P3 |
| `/workshop` | Knowledge Workshop | wiki / codegraph | P4 |

## 9. 部署形态

| 形态 | 组成 | 适用 |
| --- | --- | --- |
| 单进程 | `cinlan-knowledge serve`：API + `/mcp` + panel + `/dl`，端口 8424 | 默认 |
| systemd | 同上 + unit；release 目录 + symlink `current` | 服务器常驻 |
| Docker | 一体化镜像（参照腾讯 `panel-knowledge-combined` 的形态，但单端口） | 交付 |
| 宿主侧 | `ck` + 宿主配置里的 MCP 条目与 hook 条目（由 `ck setup` 生成） | 每台机器、每个宿主 |

数据目录只有一个 SQLite 文件（WAL）+ `backups/`。备份 = `VACUUM INTO`，恢复 = 停服换文件。

`ck` 的安装包随 hub 的 release 一起构建，由 hub 的 `/dl` 分发，所以两边版本天然配套；`ck doctor` 用 `auth/verify` 返回的 `server_version` 核对。`/api/v1` 只做加法，旧 `ck` 连新 hub 仍可用。

## 10. 安全要点

| 威胁 | 控制 |
| --- | --- |
| 错误或恶意内容进入全员 Agent 的上下文 | 新资产恒为 `private`；提升可见性按 `review_mode` 过审；配装只有 Agent Owner 与 Team Admin 能改；全部写动作进审计；版本不可变，可回退 |
| 资产正文伪造框架标签、冒充系统指令 | 渲染配装文本时转义框架标签；检索与打开的结果作为工具结果返回，带 Owner 与可见性 |
| skill 物化等于往成员机器分发可执行内容 | 只物化绑进配装的 skill；共享过审；模板里可以 `pin_version`；对安全敏感的团队用 `review_mode = all`（管理者的修改也过审）；只写带标记的用户级目录；文件路径在 hub 入库与 `ck` 落盘时各校验一次 |
| key 泄露 | 库里只有前缀与摘要，明文只在创建时返回一次；每台机器一把，可单独吊销；A1 接入下 key 不进任何宿主配置；审计可按 key 前缀回溯 |
| 吊销之后继续读档 | `401 / 403 / 404` 时不用缓存，并删除本机缓存 |
| 探测他人资产是否存在 | 不可见对象一律 `NOT_FOUND`；skill 名字的唯一性按 Owner 计，不泄露别人私有 skill 的名字 |
| 浏览器里的跨站调用、DNS rebinding | `Origin` 校验；认证只认 `Authorization` 头 |
| 链路窃听 | hub 无 TLS 时只监听内网；跨网段部署放在反代后面或开 `listen.tls` |
| `ck` 安装包被替换 | 由 hub 自己分发并附 sha256；跨网段时走 TLS |
| 日志与审计泄密 | 不记请求 body、资产正文与 key |
