# cinlan-knowledge API

约定照腾讯 MemoryPanel 的面板 API：RPC 风格、全 `POST`、统一信封、错误枚举是稳定契约。

## 1. 约定

- Base：`http(s)://<host>:8424/api/v1`。
- 业务动作全部 `POST /api/v1/<域>/<动作>`，body 为 JSON 对象（无参也发 `{}`）。
- `GET` 只有：`/healthz`（`{ "ok": true }`，不带任何库存信息）、`/panel/*`（静态资源，SPA fallback）、`/dl/*`（`ck` 安装包与 `.sha256`；不含密钥，免认证）、`/`（302 到 `/panel/`）。
- `POST /mcp`：MCP 的 Streamable HTTP 端点，见 §5。
- 未知动作 → 404 `UNKNOWN_ACTION`；非 POST → 405 `METHOD_NOT_ALLOWED`。
- `Origin`：请求带 `Origin` 头且不在 `listen.allowedOrigins` 内 → 403 `FORBIDDEN`。不带 `Origin` 的客户端（`ck`、服务端 MCP 客户端）不受影响。认证只认 `Authorization` 头，不用 cookie。

请求头：

| 头 | 必填 | 含义 |
| --- | --- | --- |
| `Authorization: Bearer <user-key>` | 是 | 身份。key 无效 / 吊销 / 过期 / 用户禁用 → 401（不带 OAuth 元数据，避免客户端跳 OAuth 发现） |
| `x-ck-agent-id` | 运行面动作必填 | 当前 Agent；必须属于该 user 且 `active`，否则 404 |
| `x-request-id` | 否 | 透传到响应与审计；缺省由 hub 生成 |

只在 `/mcp` 上有效的头（`/api/v1` 忽略并记一条警告日志）：

| 头 | 含义 |
| --- | --- |
| `x-ck-agent: <team-slug>/<agent-name>` | 替代 `x-ck-agent-id`。`/mcp` 无状态，每个请求都按 `agent/ensure` 语义解析（取或建，首次拷贝模板配装） |
| `x-ck-host` | 宿主 slug，只用于统计与 `agent.host` 的更新；**不参与授权**。缺省取 MCP `initialize` 的 `clientInfo.name` |
| `x-ck-baseline: brief \| full` | 请求 `instructions` 的详略；缺省 `full`（预算按 hub 默认 12,000 字符 / 24,000 字节） |

信封：

```json
{ "code": 0, "message": "OK", "request_id": "req_…", "data": { } }
```

```json
{ "code": 409, "message": "VERSION_CONFLICT", "request_id": "req_…", "data": { "current_version": 4 } }
```

- `code = 0` 时 HTTP 200；出错时 HTTP 状态 = `code`。
- `message` 是大写枚举，客户端只对它做分支；人读的说明放 `data.detail`。
- 分页：入参 `limit`（默认 20，≤ 100）与 `cursor`；出参 `next_cursor`（空 = 到底）。
- 引用团队与用户：入参里的 `team_id` / `user_id` 可以改传 `team` / `user`（slug），hub 解析；两者同时给且不一致 → 400。出参一律回 id。
- 幂等：`agent/ensure`、`loadout/bind`、`loadout/unbind`、`acl/grant`、`acl/revoke`、`team-member/add` 重复调用结果一致；按唯一名创建的动作重复时 409 `ALREADY_EXISTS`。
- `/api/v1` 只做加法。删字段、改语义 = `/api/v2`。

## 2. 错误枚举

| message | code | 何时 |
| --- | --- | --- |
| `OK` | 0 | 成功 |
| `INVALID_ARGUMENT` | 400 | 入参校验失败；`data.issues[]` 列出全部问题 |
| `REASON_REQUIRED` | 400 | `review/decide` 驳回未带 `reason` |
| `UNAUTHORIZED` | 401 | key 缺失 / 无效 / 吊销 / 过期，或用户被禁用 |
| `FORBIDDEN` | 403 | 对象对调用者可见，但角色不够 |
| `NOT_FOUND` | 404 | 对象不存在，或对调用者不可见（两者不可区分） |
| `UNKNOWN_ACTION` | 404 | 动作未注册 |
| `METHOD_NOT_ALLOWED` | 405 | 业务路由收到非 POST；`/mcp` 收到 `GET` / `DELETE` |
| `ALREADY_EXISTS` | 409 | 唯一名冲突 |
| `VERSION_CONFLICT` | 409 | `base_version` 与 `current_version` 不等；带 `data.current_version` |
| `REVIEW_NOT_PENDING` | 409 | 审批单已被处理或已 `stale` |
| `PAYLOAD_TOO_LARGE` | 413 | 超出正文 / 文件 / 请求体上限 |
| `RATE_LIMITED` | 429 | 带 `Retry-After`（P2） |
| `INTERNAL` | 500 | 未分类异常。任何未知错误都落到这里，不降级成 400 |
| `UNAVAILABLE` | 503 | 启动中、迁移中、维护只读 |

枚举定义在 `sdk`，hub 与所有客户端共用同一份。

## 3. 动作目录

角色缩写：SA = System Admin，TA = Team Admin，M = 团队成员，Owner = 资产或 Agent 的所有者，Mgr = 对该资产有管理权（见 [data-model.md](data-model.md) §3）。

### 3.1 身份与团队（P1）

| 动作 | 谁能调 | 说明 |
| --- | --- | --- |
| `auth/verify` | 任意有效 key | 返回 user、是否 SA、所在团队与角色，以及 `server_version` |
| `user/create` | SA | |
| `user/create-with-key` | SA | 建人并发首把 key，明文只在此响应出现一次 |
| `user/get` / `user/list` | SA | |
| `user/disable` | SA | 禁用后其全部 key 立即失效 |
| `user-key/create` | 本人；SA 可代建 | 返回明文一次 |
| `user-key/list` | 本人；SA | 只回 `prefix`、名字、时间 |
| `user-key/revoke` | 本人；SA | |
| `team/create` | SA | 创建者自动成为 TA |
| `team/get` / `team/list` | M；SA 看全部 | |
| `team/update` | TA | 含 `review_mode`、`allow_self_approve` |
| `team/delete` | SA | 仅当团队内无资产与 Agent |
| `team-member/add` / `remove` / `set-role` | TA | 至少保留一名 TA |
| `team-member/list` | M | |

### 3.2 Agent（P1）

| 动作 | 谁能调 | 说明 |
| --- | --- | --- |
| `agent/ensure` | M | 按 `(team, owner = 调用者, name)` 取或建；新建时拷贝团队模板的配装。`host` 每次都更新为最新值 |
| `agent/create` / `get` / `update` / `archive` | Owner；TA | |
| `agent/list` | M 看自己的；TA 看全团队 | |
| `agent/set-default-template` | TA | 指定某个 `is_template` 的 Agent 为团队模板 |
| `agent/get-default-template` | M | |

### 3.3 资产（P1）

| 动作 | 谁能调 | 说明 |
| --- | --- | --- |
| `asset/create` | M | 恒为 `private`、`active`、version 1 |
| `asset/get` | 可读者 | 元数据 + 指定或当前版本正文；`path` 取 skill 附属文件。带 `x-ck-agent-id` 时记一次 `opened` |
| `asset/update` | Mgr 直接；仅可读者成为提议 | 必带 `base_version` |
| `asset/list` | 登录用户 | 管理视角：按团队 / 类型 / Owner / 可见性 / 状态 / 标签过滤，分页；只回可读集合 |
| `asset/search` | 登录用户 | 运行视角：按 query 排序；只在可读集合内。P3（O-9）起可带 `query_embedding`（与回填模型同维度的向量）：FTS 与向量 KNN 双路 RRF 融合；不携带时行为与 P1 完全一致；hub 未启用向量检索时显式报错 |
| `asset/history` | 可读者 | 版本列表；`asset/get {version}` 取任一版本 |
| `asset/set-visibility` | Mgr | 提升可能进审批，降低直接生效 |
| `asset/set-status` | Mgr；SA 仅可归档 | `activate` / `deprecate` / `archive` / `restore` |
| `asset/purge` | Owner；SA | 仅 `archived` |
| `asset/import` | M | P2：导入本机的一个 skill（`ck import` 调用），落成调用者的 private 资产。返回 `created \| unchanged \| updated \| conflict`；`conflict` 时带冲突资产的摘要 |
| `acl/grant` / `acl/revoke` | Mgr | 主体 `user` / `role` / `agent`，权限 `read` / `manage` |
| `acl/list` | 对资产有 `read` 权限者 | 能读资产即可看 ACL，不要求管理权 |
| `acl/check` | 登录用户 | 自查：我（及我的某个 Agent）对某资产的权限 |

### 3.4 配装（P1）

| 动作 | 谁能调 | 说明 |
| --- | --- | --- |
| `loadout/get` | Agent Owner；TA | 绑定列表 + 每条的资产摘要与当前是否可用 |
| `loadout/set` | Agent Owner；TA | 整表替换 |
| `loadout/bind` / `loadout/unbind` | Agent Owner；TA | 增量 |
| `loadout/resolve` | Agent Owner（运行面） | 生成注入计划；也供 panel 预览 |
| `loadout/sync-template` | TA | 把模板下发到已有 Agent：`add-missing` / `replace`（P2） |

### 3.5 审批、用量、治理

| 动作 | 谁能调 | 期 | 说明 |
| --- | --- | --- | --- |
| `review/list` | TA 看团队；任何人 `mine: true` 看自己的 | P1 | |
| `review/get` | TA；申请人 | P1 | 含 diff 所需的两份原文 |
| `review/decide` | TA | P1 | `approve` / `reject`（驳回必带 `reason`） |
| `review/withdraw` | 申请人 | P1 | |
| `usage/report` | 运行面 | P1 | 批量上报 `injected` |
| `usage/summary` | TA；SA | P2 | 按资产 / 按 Agent / 冷资产 |
| `audit/list` | TA 看本团队；SA 看全部 | P2 | |
| `system/stats` / `system/integrity` / `system/backup` | SA | P2 | |
| `session/report` | 团队成员 | P3 | O-7 通道 A'：宿主侧模型抽好的候选直落私有 `draft` 资产；单次 ≤5 条、整批原子；`source` 记 `origin=capture` + `session_id`（evidence trail） |
| `inbox/adopt` | 草稿 owner | P3 | O-7：`draft → active` 直通；带 `visibility` 时走既有共享审批门（share 团队开审批、off 直接生效） |
| `embedding/put` | Mgr | P3 | O-9 通道 A：把算好的向量写回 hub；覆盖式（旧向量先删）；`version` 缺省取现行版本 |
| `embedding/pending` | 登录用户 | P3 | O-9：回填差集——可读、active、现行版本没有向量的资产 |

## 4. 关键动作示例

### `agent/ensure`

```json
{ "team": "cinlan", "name": "cc-ly", "host": "claude-code" }
```

```json
{ "agent": { "id": "agt_…", "team_id": "team_…", "name": "cc-ly", "host": "claude-code", "status": "active" }, "created": true, "template_applied": 4 }
```

### `asset/create`

```json
{
  "team_id": "team_…",
  "type": "memory",
  "title": "发版检查清单",
  "content": "发布前先跑 e2e …",
  "summary": "",
  "tags": ["release"],
  "layer": "atom"
}
```

skill 另带 `name`（slug，必填）与 `files: [{ "path": "scripts/run.sh", "encoding": "utf8 | base64", "content": "…" }]`；`content` 即 `SKILL.md` 正文。

```json
{ "asset": { "id": "ast_…", "version": 1, "visibility": "private", "status": "active", "content_hash": "…" } }
```

### `asset/update`

```json
{ "asset_id": "ast_…", "base_version": 3, "content": "…", "change_note": "补回滚步骤" }
```

三种结果：

```json
{ "changed": true, "version": 4 }
```

```json
{ "changed": false, "version": 3 }
```

```json
{ "status": "pending_review", "review_id": "rev_…", "proposed_version": 4 }
```

### `asset/set-visibility`

```json
{ "asset_id": "ast_…", "visibility": "team", "note": "发版流程，全员需要" }
```

```json
{ "status": "applied" }
```

```json
{ "status": "pending_review", "review_id": "rev_…" }
```

`visibility = restricted` 时可同时带 `acl: [{ "subject_type": "user", "subject_id": "usr_…", "permission": "read" }]`。

### `asset/search`

```json
{ "query": "发版 回滚", "types": ["memory", "skill"], "tags": [], "limit": 8 }
```

```json
{
  "hits": [
    { "asset_id": "ast_…", "type": "memory", "title": "发版检查清单", "summary": "", "snippet": "…再翻 [symlink] current…",
      "score": 7.4, "version": 3, "visibility": "team", "owner": { "id": "usr_…", "name": "yorker" },
      "team_id": "team_…", "deprecated": false, "updated_at": "2026-11-12T03:00:00Z" }
  ]
}
```

### `loadout/set`

```json
{
  "agent_id": "agt_…",
  "bindings": [
    { "asset_id": "ast_a", "priority": 10, "injection_mode": "inject" },
    { "asset_id": "ast_b", "priority": 20, "injection_mode": "tool", "pin_version": 2 }
  ]
}
```

### `loadout/resolve`

```json
{ "agent_id": "agt_…", "if_digest": "9f2c…", "budget_chars": 12000, "max_bytes": 24000, "max_items": 30 }
```

```json
{
  "not_modified": false,
  "digest": "9f2c…",
  "chars": 8421,
  "bytes": 19764,
  "text": "<cinlan_knowledge …>…</cinlan_knowledge>",
  "items": [ { "asset_id": "ast_a", "type": "memory", "title": "发版检查清单", "version": 3, "mode": "inject", "chars": 812, "downgraded": false } ],
  "skills": [ { "asset_id": "ast_s", "name": "deploy-release", "version": 2, "content_hash": "…" } ],
  "skipped": [
    { "asset_id": "ast_x", "reason": "no_access" },
    { "asset_id": "ast_y", "reason": "budget" },
    { "asset_id": "ast_z", "reason": "name_conflict" }
  ],
  "downgraded": 1,
  "generated_at": "2026-11-12T03:00:00Z"
}
```

- `skipped[].reason`：`no_access` / `not_active` / `expired` / `name_conflict` / `budget`。
- `max_bytes` 缺省不限；`budget_chars` 缺省 12,000。两者同时生效，超限项整条不进（不截断）：`inject` 项降级为目录行并标 `downgraded`，目录行放不下则记 `skipped: budget`。
- `skills[]` 列全部 `inject` 的 skill（不受预算影响，物化由客户端做）。
- `not_modified: true` 时 `text` / `chars` / `bytes` 为空表示「无需重投」；`items` / `skills` / `skipped` / `downgraded` 照常返回当前值——skill 升版本而摘要行不变时 digest 不变，客户端的物化清单要靠它刷新（2026-11-14 拍板，acceptance-report §5.4）。

### `review/decide`

```json
{ "review_id": "rev_…", "decision": "reject", "reason": "含客户名，脱敏后再提" }
```

### `usage/report`

```json
{ "agent_id": "agt_…", "events": [ { "asset_id": "ast_a", "version": 3, "kind": "injected" } ] }
```

## 5. MCP 端点

`POST /mcp`，MCP Streamable HTTP。实现在 `packages/mcp`（全仓库唯一 import MCP SDK 的地方），工具定义与 `ck mcp` 是同一份。

| 项 | 约定 |
| --- | --- |
| 传输 | 无状态：不发 `Mcp-Session-Id`，每个请求自带身份；只回 `application/json`（不升级为 SSE） |
| `GET` / `DELETE /mcp` | 405 `METHOD_NOT_ALLOWED`（无服务端推送流、无会话可删） |
| 认证 | 与 `/api/v1` 完全相同：`Authorization: Bearer <user-key>`；Agent 用 `x-ck-agent` 或 `x-ck-agent-id` |
| `initialize` | 返回 `serverInfo.name = "ck"`、`serverInfo.version`、`instructions`。`instructions` 就是 `loadout/resolve` 的文本：`x-ck-baseline: brief` 时是固定引导语（≤ 1,500 字符），否则是完整配装（默认 12,000 字符 / 24,000 字节封顶） |
| 工具 | 五个：`knowledge_search` / `knowledge_open` / `knowledge_save` / `knowledge_share` / `knowledge_status`，与动作的映射见 [loadout.md](loadout.md) §5 |
| 校验与审计 | 工具调用走进程内 `Rpc` 落到同一张动作注册表，认证、权限、审计、限流与 `/api/v1` 没有第二条路径 |
| 失败 | 协议层错误用 MCP 的 `isError: true`，文本是错误枚举前缀 + 人读说明（如 `NOT_FOUND: 资产不存在或不可见`）；不把 HTTP 状态塞进工具结果 |

工具入参出参与对应动作的字段同名同义，不做二次包装。`knowledge_open` 返回全文，不带渲染后的配装文本。

## 6. 客户端要求

- 重试只针对网络错误、`429`（遵守 `Retry-After`）、`503`，指数退避；`4xx` 其余不重试。
- 遇 `VERSION_CONFLICT` 不自动覆盖，把 `current_version` 交还调用方。
- `401 / 403 / 404` 发生在 `loadout/resolve` 时不得回退本地缓存，并删除该 Agent 的缓存文件（见 [loadout.md](loadout.md) §6）。
- 契约测试：`sdk` 里维护一份请求 / 响应 fixture，hub、`ck`、panel 的测试都读它；MCP 面用官方 client 单独验一次（T10）。改 API 形状必须同一次提交内改 fixture。
- `/api/v1` 只做加法，旧 `ck` 连新 hub 仍可用；`auth/verify` 的 `server_version` 供 `ck doctor` 做版本核对。
