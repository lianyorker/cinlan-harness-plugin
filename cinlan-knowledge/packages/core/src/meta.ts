import type {
  Agent,
  Team,
  TeamMember,
  TeamRole,
  User,
  UserKeyInfo,
} from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import { alreadyExists, forbidden, invalid, notFound } from "./errors.js";
import { digestEquals, generateUserKey, isSlug, newId, nowIso, sha256Hex } from "./ids.js";
import { makePage, readPage } from "./paging.js";
import { withTx } from "./tx.js";
import { isId, optString, Validator } from "./validate.js";

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

export type { User } from "@cinlan/knowledge-sdk";

export interface CreateUserInput {
  name: string;
  display_name: string;
  is_system_admin?: boolean;
}

interface UserRow {
  id: string;
  name: string;
  display_name: string;
  is_system_admin: number;
  status: string;
  created_at: string;
}

function toUser(row: UserRow): User {
  // node:sqlite 返回 null-prototype 对象；对调用方统一成普通对象
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    is_system_admin: row.is_system_admin === 1,
    status: row.status as User["status"],
    created_at: row.created_at,
  };
}

export function createUser(db: Db, input: CreateUserInput): User {
  if (!isSlug(input.name)) throw invalid("invalid argument", ["name must be a slug"]);
  if (getUserByName(db, input.name)) throw alreadyExists(`user name is taken: ${input.name}`);
  const user: User = {
    id: newId("usr"),
    name: input.name,
    display_name: input.display_name,
    is_system_admin: input.is_system_admin === true,
    status: "active",
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO user (id, name, display_name, is_system_admin, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.name,
    user.display_name,
    user.is_system_admin ? 1 : 0,
    user.status,
    user.created_at,
  );
  return user;
}

export function getUserByName(db: Db, name: string): User | null {
  const row = db.prepare("SELECT * FROM user WHERE name = ?").get(name) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUserById(db: Db, id: string): User | null {
  const row = db.prepare("SELECT * FROM user WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function countUsers(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number };
  return row.n;
}

/** 入参 `user_id` / `user` 二选一；同时给且不一致 → 400；都不存在 → NOT_FOUND。 */
export function resolveUserRef(
  db: Db,
  ref: { user_id?: unknown; user?: unknown },
): User {
  const v = new Validator();
  const byId = optString(v, ref, "user_id");
  const byName = optString(v, ref, "user");
  if (byId !== undefined && !isId(byId)) v.issue("user_id is malformed");
  if (byName !== undefined && !isSlug(byName)) v.issue("user must be a slug");
  v.done();

  if (byId === undefined && byName === undefined) throw invalid("invalid argument", ["user_id or user is required"]);
  const found = byId !== undefined ? getUserById(db, byId) : getUserByName(db, byName!);
  if (!found) throw notFound("user not found");
  if (byName !== undefined && found.name !== byName) throw invalid("invalid argument", ["user_id and user disagree"]);
  return found;
}

export function requireSystemAdmin(actor: User): void {
  if (!actor.is_system_admin) throw forbidden("system admin required");
}

export function listUsers(db: Db, body: Record<string, unknown>): { items: User[]; next_cursor: string } {
  const v = new Validator();
  const page = readPage(v, body);
  const query = optString(v, body, "query");
  const status = optString(v, body, "status");
  if (status !== undefined && status !== "active" && status !== "disabled") {
    v.issue("status must be one of active | disabled");
  }
  v.done();

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (status !== undefined) {
    where.push("status = ?");
    args.push(status);
  }
  if (query !== undefined && query !== "") {
    where.push("(name LIKE ? OR display_name LIKE ?)");
    args.push(`%${query}%`, `%${query}%`);
  }
  const sql = `SELECT * FROM user ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY name LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, page.limit + 1, page.offset) as unknown as UserRow[];
  return makePage(rows.map(toUser), page);
}

export function setUserDisabled(db: Db, actor: User, target: User, disabled: boolean): User {
  requireSystemAdmin(actor);
  if (disabled && target.id === actor.id) throw invalid("invalid argument", ["cannot disable yourself"]);
  const status = disabled ? "disabled" : "active";
  db.prepare("UPDATE user SET status = ? WHERE id = ?").run(status, target.id);
  return { ...target, status };
}

// ---------------------------------------------------------------------------
// user key
// ---------------------------------------------------------------------------

export interface IssuedKey {
  id: string;
  name: string;
  prefix: string;
  /** 明文只在此返回一次 */
  key: string;
  expires_at: string | null;
}

function assertSelfOrAdmin(actor: User, target: User): void {
  if (actor.id !== target.id && !actor.is_system_admin) throw forbidden("self or system admin required");
}

export function createUserKey(
  db: Db,
  user_id: string,
  name: string,
  expires_at: string | null = null,
): IssuedKey {
  const generated = generateUserKey();
  const id = newId("key");
  db.prepare(
    `INSERT INTO user_key (id, user_id, name, prefix, digest, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, user_id, name, generated.prefix, generated.digest, expires_at, nowIso());
  return { id, name, prefix: generated.prefix, key: generated.key, expires_at };
}

export function createUserKeyFor(db: Db, actor: User, target: User, name: string, expires_at: string | null): IssuedKey {
  assertSelfOrAdmin(actor, target);
  return createUserKey(db, target.id, name, expires_at);
}

interface UserKeyRow {
  id: string;
  name: string;
  prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function listUserKeys(db: Db, actor: User, target: User): UserKeyInfo[] {
  assertSelfOrAdmin(actor, target);
  const rows = db
    .prepare(
      `SELECT id, name, prefix, expires_at, revoked_at, last_used_at, created_at
       FROM user_key WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(target.id) as unknown as UserKeyRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  }));
}

/** 幂等：已吊销的 key 再吊销不报错，保持原 revoked_at。 */
export function revokeUserKey(db: Db, actor: User, target: User, key_id: string): void {
  assertSelfOrAdmin(actor, target);
  const row = db.prepare("SELECT id FROM user_key WHERE id = ? AND user_id = ?").get(key_id, target.id);
  if (!row) throw notFound("key not found");
  db.prepare("UPDATE user_key SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(nowIso(), key_id);
}

export interface VerifiedPrincipal {
  user: User;
  /** 认出的那把 key（user_key.id）；hub 按它限流 */
  key_id: string;
}

export type VerifyFailure = "shape" | "unknown" | "revoked" | "expired" | "disabled";

export type VerifyResult =
  | { ok: true; principal: VerifiedPrincipal }
  | { ok: false; reason: VerifyFailure };

/**
 * Bearer key 校验：前缀查找 → 摘要定长比较 → 吊销 / 过期 / 用户禁用。
 * 对调用方只暴露 UNAUTHORIZED，reason 仅用于日志。
 */
export function verifyUserKey(db: Db, key: string): VerifyResult {
  const m = /^ck_([0-9a-f]{8})_[0-9a-f]{32}$/.exec(key);
  if (!m) return { ok: false, reason: "shape" };
  const row = db
    .prepare(
      `SELECT k.id AS key_id, k.digest, k.revoked_at, k.expires_at, u.*
       FROM user_key k JOIN user u ON u.id = k.user_id
       WHERE k.prefix = ?`,
    )
    .get(m[1]!) as
    | (UserRow & { key_id: string; digest: string; revoked_at: string | null; expires_at: string | null })
    | undefined;
  if (!row) return { ok: false, reason: "unknown" };

  // 摘要比较对完整 key 计算，不看前缀
  if (!digestEquals(row.digest, sha256Hex(key))) return { ok: false, reason: "unknown" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (row.expires_at !== null && row.expires_at <= nowIso()) return { ok: false, reason: "expired" };
  if (row.status !== "active") return { ok: false, reason: "disabled" };

  db.prepare("UPDATE user_key SET last_used_at = ? WHERE id = ?").run(nowIso(), row.key_id);
  return { ok: true, principal: { user: toUser(row), key_id: row.key_id } };
}

// ---------------------------------------------------------------------------
// team
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  name: string;
  title: string;
  description: string;
  review_mode: string;
  allow_self_approve: number;
  template_agent_id: string | null;
  created_by: string;
  created_at: string;
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    review_mode: row.review_mode as Team["review_mode"],
    allow_self_approve: row.allow_self_approve === 1,
    template_agent_id: row.template_agent_id,
    created_at: row.created_at,
  };
}

export function getTeamById(db: Db, id: string): Team | null {
  const row = db.prepare("SELECT * FROM team WHERE id = ?").get(id) as TeamRow | undefined;
  return row ? toTeam(row) : null;
}

export function getTeamByName(db: Db, name: string): Team | null {
  const row = db.prepare("SELECT * FROM team WHERE name = ?").get(name) as TeamRow | undefined;
  return row ? toTeam(row) : null;
}

/** 入参 `team_id` / `team` 二选一；同时给且不一致 → 400。 */
export function resolveTeam(db: Db, ref: { team_id?: unknown; team?: unknown }): Team {
  const v = new Validator();
  const byId = optString(v, ref, "team_id");
  const byName = optString(v, ref, "team");
  if (byId !== undefined && !isId(byId)) v.issue("team_id is malformed");
  if (byName !== undefined && !isSlug(byName)) v.issue("team must be a slug");
  v.done();

  if (byId === undefined && byName === undefined) throw invalid("invalid argument", ["team_id or team is required"]);
  const found = byId !== undefined ? getTeamById(db, byId) : getTeamByName(db, byName!);
  if (!found) throw notFound("team not found");
  if (byName !== undefined && found.name !== byName) throw invalid("invalid argument", ["team_id and team disagree"]);
  return found;
}

export function teamRole(db: Db, team_id: string, user_id: string): TeamRole | "none" {
  const row = db
    .prepare("SELECT role FROM team_member WHERE team_id = ? AND user_id = ?")
    .get(team_id, user_id) as { role: TeamRole } | undefined;
  return row ? row.role : "none";
}

/** 角色门槛：成员（任意角色）或管理员。团队外的人拿到 NOT_FOUND，"不存在"与"无权"不可区分。 */
export function requireTeamRole(db: Db, team_id: string, user_id: string, min: "member" | "admin"): TeamRole {
  const role = teamRole(db, team_id, user_id);
  if (role === "none") throw notFound("team not found");
  if (min === "admin" && role !== "admin") throw forbidden("team admin required");
  return role;
}

export interface CreateTeamInput {
  name: string;
  title: string;
  description?: string;
}

export function createTeam(db: Db, actor: User, input: CreateTeamInput): Team {
  requireSystemAdmin(actor);
  return withTx(db, () => {
    if (!isSlug(input.name)) throw invalid("invalid argument", ["name must be a slug"]);
    if (getTeamByName(db, input.name)) throw alreadyExists(`team name is taken: ${input.name}`);
    const team: Team = {
      id: newId("team"),
      name: input.name,
      title: input.title,
      description: input.description ?? "",
      review_mode: "share",
      allow_self_approve: true,
      template_agent_id: null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO team (id, name, title, description, review_mode, allow_self_approve, template_agent_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      team.id,
      team.name,
      team.title,
      team.description,
      team.review_mode,
      team.allow_self_approve ? 1 : 0,
      team.template_agent_id,
      actor.id,
      team.created_at,
    );
    db.prepare("INSERT INTO team_member (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(
      team.id,
      actor.id,
      "admin",
      team.created_at,
    );
    return team;
  });
}

/** M 看自己所在的团队；SA 看全部。 */
export function listTeams(db: Db, actor: User, body: Record<string, unknown>): { items: Team[]; next_cursor: string } {
  const v = new Validator();
  const page = readPage(v, body);
  v.done();
  const rows = (
    actor.is_system_admin
      ? db.prepare("SELECT * FROM team ORDER BY name LIMIT ? OFFSET ?").all(page.limit + 1, page.offset)
      : db
          .prepare(
            `SELECT t.* FROM team t JOIN team_member m ON m.team_id = t.id
             WHERE m.user_id = ? ORDER BY t.name LIMIT ? OFFSET ?`,
          )
          .all(actor.id, page.limit + 1, page.offset)
  ) as unknown as TeamRow[];
  return makePage(rows.map(toTeam), page);
}

export function updateTeam(
  db: Db,
  actor: User,
  team: Team,
  patch: { title?: string; description?: string; review_mode?: Team["review_mode"]; allow_self_approve?: boolean },
): Team {
  requireTeamRole(db, team.id, actor.id, "admin");
  const next: Team = {
    ...team,
    title: patch.title ?? team.title,
    description: patch.description ?? team.description,
    review_mode: patch.review_mode ?? team.review_mode,
    allow_self_approve: patch.allow_self_approve ?? team.allow_self_approve,
  };
  db.prepare(
    `UPDATE team SET title = ?, description = ?, review_mode = ?, allow_self_approve = ? WHERE id = ?`,
  ).run(next.title, next.description, next.review_mode, next.allow_self_approve ? 1 : 0, team.id);
  return next;
}

/** 仅当团队内无资产与 Agent；成员关系一并删除。 */
export function deleteTeam(db: Db, actor: User, team: Team): void {
  requireSystemAdmin(actor);
  withTx(db, () => {
    const assets = db.prepare("SELECT COUNT(*) AS n FROM asset WHERE team_id = ?").get(team.id) as { n: number };
    const agents = db.prepare("SELECT COUNT(*) AS n FROM agent WHERE team_id = ?").get(team.id) as { n: number };
    if (assets.n > 0 || agents.n > 0) {
      throw invalid("invalid argument", [
        `team still holds ${assets.n} asset(s) and ${agents.n} agent(s)`,
      ]);
    }
    db.prepare("DELETE FROM team_member WHERE team_id = ?").run(team.id);
    db.prepare("DELETE FROM team WHERE id = ?").run(team.id);
  });
}

// ---------------------------------------------------------------------------
// team member
// ---------------------------------------------------------------------------

interface MemberRow {
  user_id: string;
  user_name: string;
  display_name: string;
  role: string;
  joined_at: string;
}

function toMember(row: MemberRow): TeamMember {
  return {
    user_id: row.user_id,
    user_name: row.user_name,
    display_name: row.display_name,
    role: row.role as TeamRole,
    joined_at: row.joined_at,
  };
}

function readMember(db: Db, team_id: string, user_id: string): TeamMember | null {
  const row = db
    .prepare(
      `SELECT m.user_id, u.name AS user_name, u.display_name, m.role, m.joined_at
       FROM team_member m JOIN user u ON u.id = m.user_id
       WHERE m.team_id = ? AND m.user_id = ?`,
    )
    .get(team_id, user_id) as MemberRow | undefined;
  return row ? toMember(row) : null;
}

function adminCount(db: Db, team_id: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM team_member WHERE team_id = ? AND role = 'admin'").get(team_id) as {
    n: number;
  }).n;
}

/** 幂等：已是成员时原样返回，不改角色。 */
export function addMember(db: Db, actor: User, team: Team, target: User, role: TeamRole = "member"): TeamMember {
  requireTeamRole(db, team.id, actor.id, "admin");
  const existing = readMember(db, team.id, target.id);
  if (existing) return existing;
  db.prepare("INSERT INTO team_member (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(
    team.id,
    target.id,
    role,
    nowIso(),
  );
  return readMember(db, team.id, target.id)!;
}

export function removeMember(db: Db, actor: User, team: Team, target: User): void {
  requireTeamRole(db, team.id, actor.id, "admin");
  const existing = readMember(db, team.id, target.id);
  if (!existing) throw notFound("member not found");
  if (existing.role === "admin" && adminCount(db, team.id) <= 1) {
    throw invalid("invalid argument", ["team must keep at least one admin"]);
  }
  db.prepare("DELETE FROM team_member WHERE team_id = ? AND user_id = ?").run(team.id, target.id);
}

export function setMemberRole(db: Db, actor: User, team: Team, target: User, role: TeamRole): TeamMember {
  requireTeamRole(db, team.id, actor.id, "admin");
  const existing = readMember(db, team.id, target.id);
  if (!existing) throw notFound("member not found");
  if (existing.role === "admin" && role !== "admin" && adminCount(db, team.id) <= 1) {
    throw invalid("invalid argument", ["team must keep at least one admin"]);
  }
  db.prepare("UPDATE team_member SET role = ? WHERE team_id = ? AND user_id = ?").run(role, team.id, target.id);
  return readMember(db, team.id, target.id)!;
}

export function listMembers(db: Db, actor: User, team: Team): TeamMember[] {
  if (!actor.is_system_admin) requireTeamRole(db, team.id, actor.id, "member");
  const rows = db
    .prepare(
      `SELECT m.user_id, u.name AS user_name, u.display_name, m.role, m.joined_at
       FROM team_member m JOIN user u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY u.name`,
    )
    .all(team.id) as unknown as MemberRow[];
  return rows.map(toMember);
}

export interface Membership {
  team_id: string;
  team: string;
  role: TeamRole;
}

export function teamsOfUser(db: Db, user_id: string): Membership[] {
  // node:sqlite 返回 null-prototype 对象；对调用方统一成普通对象
  const rows = db
    .prepare(
      `SELECT t.id AS team_id, t.name AS team, m.role
       FROM team_member m JOIN team t ON t.id = m.team_id
       WHERE m.user_id = ?
       ORDER BY t.name`,
    )
    .all(user_id) as { team_id: string; team: string; role: TeamRole }[];
  return rows.map((r) => ({ team_id: r.team_id, team: r.team, role: r.role }));
}

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  host: string;
  description: string;
  is_template: number;
  status: string;
  last_seen_at: string | null;
  created_at: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    team_id: row.team_id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    host: row.host,
    description: row.description,
    is_template: row.is_template === 1,
    status: row.status as Agent["status"],
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  };
}

export function getAgent(db: Db, id: string): Agent | null {
  const row = db.prepare("SELECT * FROM agent WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function getAgentByName(db: Db, team_id: string, owner_user_id: string, name: string): Agent | null {
  const row = db
    .prepare("SELECT * FROM agent WHERE team_id = ? AND owner_user_id = ? AND name = ?")
    .get(team_id, owner_user_id, name) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/** Owner 或 TA；团队外的人拿 NOT_FOUND。 */
export function requireAgentAccess(db: Db, actor: User, agent: Agent): void {
  if (agent.owner_user_id === actor.id) return;
  const role = teamRole(db, agent.team_id, actor.id);
  if (role === "admin") return;
  if (role === "none") throw notFound("agent not found");
  throw forbidden("agent owner or team admin required");
}

export function createAgent(
  db: Db,
  actor: User,
  team: Team,
  input: { name: string; host: string; description?: string; is_template?: boolean },
): Agent {
  const role = requireTeamRole(db, team.id, actor.id, "member");
  if (input.is_template === true && role !== "admin") throw forbidden("team admin required for templates");
  return withTx(db, () => {
    if (!isSlug(input.name)) throw invalid("invalid argument", ["name must be a slug"]);
    if (getAgentByName(db, team.id, actor.id, input.name)) {
      throw alreadyExists(`agent name is taken in this team: ${input.name}`);
    }
    const agent: Agent = {
      id: newId("agt"),
      team_id: team.id,
      owner_user_id: actor.id,
      name: input.name,
      host: input.host,
      description: input.description ?? "",
      is_template: input.is_template === true,
      status: "active",
      last_seen_at: null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO agent (id, team_id, owner_user_id, name, host, description, is_template, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.id,
      agent.team_id,
      agent.owner_user_id,
      agent.name,
      agent.host,
      agent.description,
      agent.is_template ? 1 : 0,
      agent.status,
      agent.last_seen_at,
      agent.created_at,
    );
    return agent;
  });
}

/**
 * 按 (team, owner = 调用者, name) 取或建。
 * 取到时只刷新 host / last_seen_at；新建时拷贝团队模板的配装（source = 'template'）。
 */
export function ensureAgent(
  db: Db,
  actor: User,
  team: Team,
  input: { name: string; host: string; description?: string },
): { agent: Agent; created: boolean; template_applied: number } {
  requireTeamRole(db, team.id, actor.id, "member");
  return withTx(db, () => {
    if (!isSlug(input.name)) throw invalid("invalid argument", ["name must be a slug"]);
    const now = nowIso();
    const existing = getAgentByName(db, team.id, actor.id, input.name);
    if (existing) {
      db.prepare("UPDATE agent SET host = ?, last_seen_at = ? WHERE id = ?").run(input.host, now, existing.id);
      return { agent: { ...existing, host: input.host, last_seen_at: now }, created: false, template_applied: 0 };
    }

    const agent: Agent = {
      id: newId("agt"),
      team_id: team.id,
      owner_user_id: actor.id,
      name: input.name,
      host: input.host,
      description: input.description ?? "",
      is_template: false,
      status: "active",
      last_seen_at: now,
      created_at: now,
    };
    db.prepare(
      `INSERT INTO agent (id, team_id, owner_user_id, name, host, description, is_template, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.id,
      agent.team_id,
      agent.owner_user_id,
      agent.name,
      agent.host,
      agent.description,
      agent.is_template ? 1 : 0,
      agent.status,
      agent.last_seen_at,
      agent.created_at,
    );

    let applied = 0;
    // 入参 team 可能是旧快照；模板指针以库里为准
    const templateId = getTeamById(db, team.id)?.template_agent_id ?? null;
    if (templateId !== null) {
      const result = db
        .prepare(
          `INSERT INTO agent_asset (agent_id, asset_id, priority, injection_mode, pin_version, source, bound_by, created_at)
           SELECT ?, asset_id, priority, injection_mode, pin_version, 'template', ?, ?
           FROM agent_asset WHERE agent_id = ?`,
        )
        .run(agent.id, actor.id, now, templateId);
      applied = Number(result.changes);
    }
    return { agent, created: true, template_applied: applied };
  });
}

export function updateAgent(
  db: Db,
  actor: User,
  agent: Agent,
  patch: { description?: string; host?: string; is_template?: boolean },
): Agent {
  requireAgentAccess(db, actor, agent);
  if (patch.is_template === true && teamRole(db, agent.team_id, actor.id) !== "admin") {
    throw forbidden("team admin required for templates");
  }
  const next: Agent = {
    ...agent,
    description: patch.description ?? agent.description,
    host: patch.host ?? agent.host,
    is_template: patch.is_template ?? agent.is_template,
  };
  db.prepare("UPDATE agent SET description = ?, host = ?, is_template = ? WHERE id = ?").run(
    next.description,
    next.host,
    next.is_template ? 1 : 0,
    agent.id,
  );
  return next;
}

/** 归档幂等；归档后 Agent 不能再用 x-ck-agent-id 调运行面动作。 */
export function archiveAgent(db: Db, actor: User, agent: Agent): Agent {
  requireAgentAccess(db, actor, agent);
  db.prepare("UPDATE agent SET status = 'archived' WHERE id = ?").run(agent.id);
  return { ...agent, status: "archived" };
}

/** M 看自己的；TA 看全团队。include_archived 默认 false。 */
export function listAgents(
  db: Db,
  actor: User,
  team: Team,
  body: Record<string, unknown>,
): { items: Agent[]; next_cursor: string } {
  const v = new Validator();
  const page = readPage(v, body);
  const ownerId = optString(v, body, "owner_user_id");
  const includeArchived = body["include_archived"] === true;
  v.done();

  const role = teamRole(db, team.id, actor.id);
  if (role === "none" && !actor.is_system_admin) throw notFound("team not found");

  const where = ["team_id = ?"];
  const args: (string | number)[] = [team.id];
  if (role !== "admin") {
    where.push("owner_user_id = ?");
    args.push(actor.id);
  } else if (ownerId !== undefined) {
    where.push("owner_user_id = ?");
    args.push(ownerId);
  }
  if (!includeArchived) where.push("status = 'active'");

  const rows = db
    .prepare(`SELECT * FROM agent WHERE ${where.join(" AND ")} ORDER BY name LIMIT ? OFFSET ?`)
    .all(...args, page.limit + 1, page.offset) as unknown as AgentRow[];
  return makePage(rows.map(toAgent), page);
}

export function setDefaultTemplate(db: Db, actor: User, team: Team, agent: Agent): Team {
  requireTeamRole(db, team.id, actor.id, "admin");
  if (agent.team_id !== team.id) throw notFound("agent not found");
  if (!agent.is_template) throw invalid("invalid argument", ["agent is not a template"]);
  if (agent.status !== "active") throw invalid("invalid argument", ["agent is archived"]);
  db.prepare("UPDATE team SET template_agent_id = ? WHERE id = ?").run(agent.id, team.id);
  return { ...team, template_agent_id: agent.id };
}

export function getDefaultTemplate(db: Db, actor: User, team: Team): Agent | null {
  if (!actor.is_system_admin) requireTeamRole(db, team.id, actor.id, "member");
  // 入参 team 可能是调用方持有的旧快照，模板指针以库里为准
  const current = getTeamById(db, team.id);
  if (!current || current.template_agent_id === null) return null;
  // 模板 Agent 被归档时视为没有模板
  const agent = getAgent(db, current.template_agent_id);
  return agent && agent.status === "active" ? agent : null;
}
