# 数据模型

存储：SQLite 单文件（`<dataDir>/knowledge.db`，WAL），经 `core/src/db.ts` 访问。时间一律 ISO-8601 UTC 字符串。JSON 列存文本。

## 1. 表

```sql
CREATE TABLE user (
  id              TEXT PRIMARY KEY,            -- usr_<24hex>
  name            TEXT NOT NULL UNIQUE,        -- 登录名 slug
  display_name    TEXT NOT NULL,
  is_system_admin INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at      TEXT NOT NULL
);

CREATE TABLE user_key (
  id           TEXT PRIMARY KEY,               -- key_<24hex>
  user_id      TEXT NOT NULL REFERENCES user(id),
  name         TEXT NOT NULL,                  -- 用途标注，如 "ly-laptop"
  prefix       TEXT NOT NULL UNIQUE,           -- 明文前缀：查找与展示用
  digest       TEXT NOT NULL,                  -- sha256(完整 key)
  expires_at   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE team (
  id                 TEXT PRIMARY KEY,         -- team_<24hex>
  name               TEXT NOT NULL UNIQUE,     -- slug
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  review_mode        TEXT NOT NULL DEFAULT 'share',   -- off | share | all
  allow_self_approve INTEGER NOT NULL DEFAULT 1,
  template_agent_id  TEXT,                     -- 团队默认 Agent 模板
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE team_member (
  team_id   TEXT NOT NULL REFERENCES team(id),
  user_id   TEXT NOT NULL REFERENCES user(id),
  role      TEXT NOT NULL,                     -- admin | member
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE agent (
  id            TEXT PRIMARY KEY,              -- agt_<24hex>
  team_id       TEXT NOT NULL REFERENCES team(id),
  owner_user_id TEXT NOT NULL REFERENCES user(id),
  name          TEXT NOT NULL,                 -- slug，如 "dsh-ly"
  host          TEXT NOT NULL,                 -- 宿主 slug（dsh | claude-code | codex | gemini-cli | …）；只用于统计，每次 agent/ensure 覆盖为最新值
  description   TEXT NOT NULL DEFAULT '',
  is_template   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',     -- active | archived
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (team_id, owner_user_id, name)
);

CREATE TABLE asset (
  seq             INTEGER PRIMARY KEY,         -- 内部整数主键；FTS 的 rowid 指向它，不出现在客户端契约里
  id              TEXT NOT NULL UNIQUE,        -- ast_<24hex>，服务端生成
  team_id         TEXT NOT NULL REFERENCES team(id),
  type            TEXT NOT NULL,               -- memory | skill（wiki | codegraph：P4）
  name            TEXT,                        -- slug；skill 必填，memory 可空
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  layer           TEXT,                        -- 仅 memory：core | profile | atom
  tags            TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  owner_user_id   TEXT NOT NULL REFERENCES user(id),
  visibility      TEXT NOT NULL DEFAULT 'private',  -- private | team | restricted | agent
  status          TEXT NOT NULL DEFAULT 'active',   -- draft | active | deprecated | archived
  current_version INTEGER NOT NULL DEFAULT 1,
  expires_at      TEXT,
  usage_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  source          TEXT NOT NULL DEFAULT '{}',  -- JSON {origin: tool|panel|import|capture, host, agent_id, session_id, import_path}
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
-- skill 名字按 Owner 唯一：多人各自导入同名私有 skill 是常态，团队级唯一会互相卡死并泄露"名字已被占用"
CREATE UNIQUE INDEX asset_name ON asset(team_id, type, owner_user_id, name) WHERE name IS NOT NULL;
-- 提升可见性时在同一事务内再查一次团队内同类同名（非 private）资产，命中则 ALREADY_EXISTS

CREATE TABLE asset_version (
  asset_id       TEXT NOT NULL REFERENCES asset(id),
  version        INTEGER NOT NULL,             -- 单调递增，可有空洞（被驳回的提议保留编号）
  state          TEXT NOT NULL DEFAULT 'committed', -- committed | proposed | rejected
  base_version   INTEGER,                      -- 基于哪个已提交版本
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  content        TEXT NOT NULL,                -- memory 正文 / skill 的 SKILL.md
  content_hash   TEXT NOT NULL,                -- hub 计算
  author_user_id TEXT NOT NULL,
  change_note    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (asset_id, version)
);

CREATE TABLE asset_file (                      -- skill 的附属文件（SKILL.md 不在此表）
  asset_id TEXT NOT NULL,
  version  INTEGER NOT NULL,
  path     TEXT NOT NULL,                      -- 相对路径，`/` 分隔
  bytes    INTEGER NOT NULL,
  sha256   TEXT NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (asset_id, version, path)
);

CREATE TABLE acl (
  asset_id     TEXT NOT NULL REFERENCES asset(id),
  subject_type TEXT NOT NULL,                  -- user | role | agent
  subject_id   TEXT NOT NULL,                  -- usr_… | admin | member | agt_…
  permission   TEXT NOT NULL,                  -- read | manage
  granted_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (asset_id, subject_type, subject_id)
);

CREATE TABLE agent_asset (                     -- 配装：固定绑定
  agent_id       TEXT NOT NULL REFERENCES agent(id),
  asset_id       TEXT NOT NULL REFERENCES asset(id),
  priority       INTEGER NOT NULL DEFAULT 100, -- 小者先
  injection_mode TEXT NOT NULL DEFAULT 'inject',    -- inject | tool
  pin_version    INTEGER,                      -- 空 = 跟随 current_version
  source         TEXT NOT NULL DEFAULT 'manual',    -- manual | template
  bound_by       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_id, asset_id)
);

CREATE TABLE review (
  id                TEXT PRIMARY KEY,          -- rev_<24hex>
  team_id           TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES asset(id),
  kind              TEXT NOT NULL,             -- share | update | retire
  payload           TEXT NOT NULL,             -- JSON：{to_visibility, acl?} | {version} | {to_status}
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | withdrawn | stale
  requester_user_id TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  reviewer_user_id  TEXT,
  reason            TEXT,
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);

CREATE TABLE usage_daily (
  day      TEXT NOT NULL,                      -- YYYY-MM-DD
  asset_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  injected INTEGER NOT NULL DEFAULT 0,
  opened   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, asset_id, agent_id)
);

CREATE TABLE audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  request_id     TEXT,
  actor_user_id  TEXT,
  actor_agent_id TEXT,
  action         TEXT NOT NULL,                -- 与 API 动作同名，如 asset/set-visibility
  target_type    TEXT,
  target_id      TEXT,
  detail         TEXT NOT NULL DEFAULT '{}'    -- JSON；不含正文与密钥
);

CREATE VIRTUAL TABLE asset_fts USING fts5(title, tags, summary, body, tokenize = 'trigram');
-- rowid = asset.seq（显式写入，不用隐式 rowid）；只索引 current 且 committed 的版本；与资产写入同事务维护
-- SQLite 文档不保证 VACUUM 后隐式 rowid 不变，而本库的备份靠 VACUUM INTO，所以必须显式绑定
```

P3 保留（L0 对话与抽取）：`session`、`session_turn`、`extraction_job`，到 P3 再定字段。

## 2. 标识与校验

| 项 | 规则 |
| --- | --- |
| 各类 id | `<前缀>_<24hex>`，`crypto.randomBytes(12)`，服务端生成。**id 永不取自标题或文件名**，中文标题因此无任何限制 |
| slug（team.name / agent.name / user.name / skill 的 asset.name） | `/^[a-z0-9][a-z0-9-]{0,63}$/` |
| User Key | `ck_<8 位前缀>_<32 位随机>`；库里只有 `prefix` 与 `digest` |
| skill 文件路径 | 相对路径；`/` 分隔；不得含 `..`、反斜杠、盘符、前导 `/`；≤ 200 字符 |
| 大小上限 | `title` ≤ 120 字符；`summary` ≤ 300 字符（配装目录行取前 80 字符）；正文 ≤ 256 KB；单文件 ≤ 5 MB；单 skill ≤ 200 个文件且 ≤ 20 MB |
| tags | 每个 ≤ 32 字符，≤ 16 个；入库前去重排序 |
| skill 的 `SKILL.md` | 必须有 YAML frontmatter，`name` 等于 `asset.name`，`description` 非空（单行标量或块标量 `>` / `|` 都认，块标量为空等同缺失）；否则入库即 `INVALID_ARGUMENT`（多个宿主遇到缺 frontmatter 的 skill 会静默忽略） |

## 3. 可见性与权限

判定只在 `core/src/access.ts` 实现一次。principal = `{ user, agent? }`，agent 必属于该 user。

```
role(u, t)   = team_member 里 u 在 t 的角色，没有则 none

canRead(p, a)：
  a.status = draft            → 仅 a.owner = p.user
  a.status = archived         → 仅 canManage(p, a)
  canManage(p, a)             → 是
  a.owner = p.user            → 是
  a.visibility = team         且 role(p.user, a.team) ≠ none                         → 是
  a.visibility = restricted   且 acl 命中 user:p.user | role:role(p.user, a.team) | agent:p.agent → 是
  a.visibility = agent        且 agent_asset 存在 (p.agent, a)                        → 是
  其余                         → 否（对外一律 NOT_FOUND）

canManage(p, a)：
  a.owner = p.user                                             → 是
  a.visibility ≠ private 且 role(p.user, a.team) = admin        → 是
  acl 命中且 permission = manage                                → 是
  其余                                                          → 否
```

读权限跟着**人**走：Agent 继承其 Owner 的读权限，再由配装收窄到实际注入的那几条。一个人在多个团队时，其 Agent 能检索到这些团队里 `team` 可见的资产；Agent 的 `team_id` 只决定它归谁管、用哪个模板。

| 调用者 | private | team | restricted | agent |
| --- | --- | --- | --- | --- |
| Owner | 读 管 | 读 管 | 读 管 | 读 管 |
| 资产所属团队的 Admin | 不可见 | 读 管 | 读 管 | 读 管 |
| 资产所属团队的 Member | 不可见 | 读 | 按 ACL | 仅其被绑定的 Agent 可读 |
| 团队外的人 | 不可见 | 不可见 | 按 ACL（user / agent 主体） | 仅当其 Agent 在 `agent_asset` 里（绑定即授权，不限成员身份） |
| System Admin（非成员） | 仅元数据 + 归档 | 仅元数据 + 归档 | 仅元数据 + 归档 | 仅元数据 + 归档 |

矩阵只是上面 canRead / canManage 规则的速览；发生冲突时以规则（与 `access.ts` 的实现）为准，修正矩阵而不是实现。

System Admin 的治理兜底只有两样：看元数据（id / 类型 / Owner / 大小 / 状态 / 用量）与强制归档，都留审计；读不到非本人资产的正文。

谁能建绑定：Agent Owner 可以把自己可读的资产绑到自己的 Agent；Team Admin 可以给本团队任意 Agent 绑定该 Agent 的 Owner 可读的资产，以及本团队 `agent` 可见的资产（绑定本身即授权）。

## 4. 状态机

```
draft ──activate──▶ active ──deprecate──▶ deprecated ──archive──▶ archived ──purge──▶ 物理删除
                      ▲                        │                      │
                      └──────reactivate────────┴──────restore─────────┘
```

| 状态 | 检索 | 注入 | 可见范围 |
| --- | --- | --- | --- |
| `draft` | 仅 Owner | 否 | 仅 Owner（自动沉淀的落点，P3） |
| `active` | 是 | 是 | 按可见性 |
| `deprecated` | 是，降权并带标记 | 否，配装页告警 | 按可见性 |
| `archived` | 否 | 否 | 仅管理者，可恢复 |

过期（`expires_at` 早于当前时间）只在检索与配装上等同不可读：`NOT_EXPIRED_SQL` 挂在 `RESOLVE_WHERE_SQL` 一处，检索不命中、配装跳过。`canRead` 不含过期条件——Owner 仍能 `asset/get` 并续期，否则过期即资产自杀。要彻底撤出使用走 `deprecate` / `archive`。

`purge` 只对 `archived` 资产开放，删除全部版本与文件，audit 留一条不含正文的记录。

## 5. 版本与并发

- 版本行不可变。改内容 = 新增版本行；`asset.current_version` 是指针。
- 修改必须带 `base_version`。与 `current_version` 不等 → `VERSION_CONFLICT`，响应里带 `current_version`。客户端不得自动覆盖重试。
- 内容未变（`content_hash` 与元数据都相同）→ 返回当前版本，`changed: false`，不产生新版本。
- 提议修改（无管理权的人）：写成 `state = proposed` 的版本行并建 `review(kind = update)`。批准时若 `base_version ≠ current_version`，审批单置 `stale`（`proposed` 版本行保留编号与状态，不落库），申请人基于新版本重提；否则把该行置 `committed` 并推进指针。驳回置 `rejected`，编号保留。
- 配装 `pin_version` 只能指向 `committed` 版本。

`content_hash` 全系统只有 hub 计算，客户端不传：

```
memory：sha256(stableStringify({ title, summary, content, tags, layer, expires_at }))
skill ：sha256(stableStringify({ title, summary, content, tags, files: [{ path, sha256 }] 按 path 排序 }))
```

`system/integrity` 用同一个函数复算。

## 6. 审批策略

团队级两个开关：`review_mode`（`off` / `share` / `all`，默认 `share`）与 `allow_self_approve`（默认开）。

| 动作 | 调用者 | off | share | all |
| --- | --- | --- | --- | --- |
| 新建（恒为 private） | 任何成员 | 直接 | 直接 | 直接 |
| 改自己的 private 资产 | Owner | 直接 | 直接 | 直接 |
| 提升可见性（private → team / restricted / agent） | 管理者 | 直接 | 需审批 | 需审批 |
| 修改非 private 资产 | 管理者 | 直接 | 直接 | 需审批 |
| 修改非 private 资产 | 仅可读者 | FORBIDDEN | 需审批（提议） | 需审批（提议） |
| 弃用 / 归档非 private 资产 | 管理者 | 直接 | 直接 | 需审批 |
| 降低可见性 | 管理者 | 直接 | 直接 | 直接 |

"需审批"的执行规则：

- 审批人 = 资产所属团队的 Admin。
- 申请人自己是 Admin 且 `allow_self_approve` 开 → 当场生效，仍写一条 `approved` 的 review（审批人 = 本人），审计可查。单人团队因此不会被自己卡住。
- `reject` 必须带 `reason`；申请人通过 `review/list {mine: true}` 与 `knowledge_status` 看到结果。
- 同一资产同类 `pending` 申请只保留最新一条，旧的置 `withdrawn`。
- 裁决用条件更新（`UPDATE review SET … WHERE id = ? AND status = 'pending'`，检查影响行数），与资产变更在同一事务。

降低可见性后，其他 Agent 上的旧绑定不删除；`loadout/resolve` 会跳过并在 `skipped[]` 里报 `no_access`。

## 7. 用量与审计

- 用量事件两种：`injected`（A1 下由 `ck` 在真正送达后经 `usage/report` 上报，本机按 `(agent, digest)` 去重、60 秒内只报一次；A0 下由 hub 在 `/mcp` 的 `initialize` 里直接记）与 `opened`（带 `x-ck-agent-id` 的 `asset/get` 由 hub 记）。按天聚合进 `usage_daily`，同时累加 `asset.usage_count` 与 `last_used_at`。保留 180 天。
- 审计覆盖所有写动作与登录失败。`detail` 记变更前后的元数据（可见性、状态、版本号、绑定），不记正文与 key。只追加，不提供删除接口。

## 8. memory 的分层

对应腾讯 L0–L3，落在 `asset.layer` 上：

| 腾讯 | 我们 | 含义 | 默认消费方式 |
| --- | --- | --- | --- |
| L3 Core / Persona | `core` | 团队规范、长期约定 | 绑进模板，`inject` |
| L2 Scenario | `profile` | 某个 Agent / 场景的画像与惯例 | 绑到对应 Agent，`inject` |
| L1 Atom | `atom` | 单条事实、教训、结论 | 不绑定，按需检索 |
| L0 Conversation | 不是资产 | 原始对话，P3 进 `session_turn` | 只作抽取原料 |

P1 的 layer 由人或模型在保存时指定；P3 才有 L0 → 草稿的自动抽取。

## 9. 本机 skill 的导入映射（P2）

`ck import --source <host>` 把本机宿主 skill 目录里的 skill 登记为资产。demo 的旧数据不迁移（decisions O-5）。

| 来源 | 新模型 |
| --- | --- |
| 宿主 skill 目录里的 `<dir>/SKILL.md` + 附属文件 | `asset(type = skill, name = <frontmatter 的 name>)`（目录名不参与取名，两者不同按 frontmatter 登记），`content` = `SKILL.md` 正文，附属文件进 `asset_file`，`source = {origin: import, host, import_path}` |
| 带 `.cinlan-knowledge.json` 标记的目录 | 跳过（本来就是我们从 hub 物化下去的） |
| 目录缺 YAML frontmatter 或 `description`（含空的块标量），或 frontmatter `name` 不是合法 slug | 跳过，计入 `skipped`，不因一条坏数据中断整批 |
| 与本人在同团队下已有的同名 skill | 内容相同 → `unchanged`；不同 → `conflict`，除非带 `on_conflict: "new_version"`（`--update`）→ `updated` |
| 落库后的可见性 | 恒为 `private`，Owner = 调用者；要共享仍走 `knowledge_share` 与审批 |
