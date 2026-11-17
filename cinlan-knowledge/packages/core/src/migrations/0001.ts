/**
 * 迁移 0001：全部 P1 表 + FTS5。
 * 版式与 docs/data-model.md §1 一致；改表必须新增迁移，不改这里。
 */
export const version = 1;
export const name = "init";

export const sql = `
CREATE TABLE user (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  is_system_admin INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL
);

CREATE TABLE user_key (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id),
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL UNIQUE,
  digest       TEXT NOT NULL,
  expires_at   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX user_key_user ON user_key(user_id);

CREATE TABLE team (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  review_mode        TEXT NOT NULL DEFAULT 'share',
  allow_self_approve INTEGER NOT NULL DEFAULT 1,
  template_agent_id  TEXT,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE team_member (
  team_id   TEXT NOT NULL REFERENCES team(id),
  user_id   TEXT NOT NULL REFERENCES user(id),
  role      TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_member_user ON team_member(user_id);

CREATE TABLE agent (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES team(id),
  owner_user_id TEXT NOT NULL REFERENCES user(id),
  name          TEXT NOT NULL,
  host          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  is_template   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (team_id, owner_user_id, name)
);

CREATE TABLE asset (
  seq             INTEGER PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  team_id         TEXT NOT NULL REFERENCES team(id),
  type            TEXT NOT NULL,
  name            TEXT,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  layer           TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  owner_user_id   TEXT NOT NULL REFERENCES user(id),
  visibility      TEXT NOT NULL DEFAULT 'private',
  status          TEXT NOT NULL DEFAULT 'active',
  current_version INTEGER NOT NULL DEFAULT 1,
  expires_at      TEXT,
  usage_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  source          TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX asset_name ON asset(team_id, type, owner_user_id, name) WHERE name IS NOT NULL;
CREATE INDEX asset_team ON asset(team_id, type, status);
CREATE INDEX asset_owner ON asset(owner_user_id);

CREATE TABLE asset_version (
  asset_id       TEXT NOT NULL REFERENCES asset(id),
  version        INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'committed',
  base_version   INTEGER,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  change_note    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (asset_id, version)
);

CREATE TABLE asset_file (
  asset_id TEXT NOT NULL,
  version  INTEGER NOT NULL,
  path     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  sha256   TEXT NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (asset_id, version, path)
);

CREATE TABLE acl (
  asset_id     TEXT NOT NULL REFERENCES asset(id),
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  permission   TEXT NOT NULL,
  granted_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (asset_id, subject_type, subject_id)
);

CREATE TABLE agent_asset (
  agent_id       TEXT NOT NULL REFERENCES agent(id),
  asset_id       TEXT NOT NULL REFERENCES asset(id),
  priority       INTEGER NOT NULL DEFAULT 100,
  injection_mode TEXT NOT NULL DEFAULT 'inject',
  pin_version    INTEGER,
  source         TEXT NOT NULL DEFAULT 'manual',
  bound_by       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_id, asset_id)
);

CREATE TABLE review (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES asset(id),
  kind              TEXT NOT NULL,
  payload           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  requester_user_id TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  reviewer_user_id  TEXT,
  reason            TEXT,
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);
CREATE INDEX review_pending ON review(team_id, status, created_at);

CREATE TABLE usage_daily (
  day      TEXT NOT NULL,
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
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  detail         TEXT NOT NULL DEFAULT '{}'
);

CREATE VIRTUAL TABLE asset_fts USING fts5(title, tags, summary, body, tokenize = 'trigram');
`;

export default { version, name, sql };
