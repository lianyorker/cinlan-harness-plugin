import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupTo, closeDatabase, currentVersion, MIGRATIONS, migrate, openDatabase } from "../src/db.js";
import { createUser, createUserKey, getUserByName, countUsers, verifyUserKey, teamsOfUser } from "../src/meta.js";
import {
  addMember,
  archiveAgent,
  createAgent,
  createTeam,
  deleteTeam,
  ensureAgent,
  getDefaultTemplate,
  getTeamByName,
  listAgents,
  listMembers,
  listTeams,
  listUserKeys,
  removeMember,
  requireTeamRole,
  resolveTeam,
  resolveUserRef,
  revokeUserKey,
  setDefaultTemplate,
  setMemberRole,
  setUserDisabled,
  updateTeam,
} from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import { generateUserKey, isSlug, newId, sha256Hex, stableStringify } from "../src/ids.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-core-"));
}

/**
 * Windows 上 SQLite / 杀软会短暂持有句柄，rmSync 需要退避重试。
 * 清理是测试卫生问题，不是断言对象：最终仍失败就放弃，由系统清理临时目录。
 */
function cleanup(dir: string): void {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") return;
    }
  }
}

test("migration 0001 applies and is idempotent", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "knowledge.db");
    const db = openDatabase({ file });
    assert.equal(currentVersion(db), MIGRATIONS.length);
    assert.deepEqual(migrate(db), [], "second run applies nothing");

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of ["user", "user_key", "team", "team_member", "agent", "asset", "asset_version", "asset_file", "acl", "agent_asset", "review", "usage_daily", "audit", "asset_fts"]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    // asset_fts 是虚表，sqlite_master 里 type='table'
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='asset_fts'").get() as { n: number }).n,
      1,
    );
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("ids: prefix_24hex, slug, key shape", () => {
  const id = newId("ast");
  assert.match(id, /^ast_[0-9a-f]{24}$/);
  assert.ok(isSlug("deploy-release"));
  assert.ok(isSlug("a"));
  assert.ok(!isSlug("Deploy"));
  assert.ok(!isSlug("-x"));
  assert.ok(!isSlug("a".repeat(65)));

  const gk = generateUserKey();
  assert.match(gk.key, /^ck_[0-9a-f]{8}_[0-9a-f]{32}$/);
  assert.equal(gk.prefix, gk.key.slice(3, 11));
  assert.equal(gk.digest, sha256Hex(gk.key));
});

test("user + key lifecycle: verify ok, revoked, unknown, malformed", () => {
  const dir = tempDir();
  try {
    const db = openDatabase({ file: join(dir, "knowledge.db") });
    const user = createUser(db, { name: "yorker", display_name: "Yorker", is_system_admin: true });
    assert.equal(countUsers(db), 1);
    assert.deepEqual(getUserByName(db, "yorker"), user);

    const issued = createUserKey(db, user.id, "ly-laptop");
    const good = verifyUserKey(db, issued.key);
    assert.equal(good.ok, true);
    if (good.ok) {
      assert.equal(good.principal.user.id, user.id);
      assert.equal(good.principal.user.is_system_admin, true);
      // 认出的是哪一把 key：hub 按它限流
      assert.equal(good.principal.key_id, issued.id);
    }

    assert.deepEqual(verifyUserKey(db, "ck_deadbeef_" + "0".repeat(32)), { ok: false, reason: "unknown" });
    assert.deepEqual(verifyUserKey(db, "not-a-key"), { ok: false, reason: "shape" });
    // 前缀正确但 secret 错：必须落到 unknown，不是 shape
    const wrongSecret = "ck_" + issued.key.slice(3, 11) + "_" + "1".repeat(32);
    assert.deepEqual(verifyUserKey(db, wrongSecret), { ok: false, reason: "unknown" });

    db.prepare("UPDATE user_key SET revoked_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", issued.id);
    assert.deepEqual(verifyUserKey(db, issued.key), { ok: false, reason: "revoked" });

    db.prepare("UPDATE user_key SET revoked_at = NULL, expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", issued.id);
    assert.deepEqual(verifyUserKey(db, issued.key), { ok: false, reason: "expired" });

    db.prepare("UPDATE user_key SET expires_at = NULL WHERE id = ?").run(issued.id);
    db.prepare("UPDATE user SET status = 'disabled' WHERE id = ?").run(user.id);
    assert.deepEqual(verifyUserKey(db, issued.key), { ok: false, reason: "disabled" });

    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("teamsOfUser returns memberships", () => {
  const dir = tempDir();
  try {
    const db = openDatabase({ file: join(dir, "knowledge.db") });
    const user = createUser(db, { name: "ly", display_name: "LY" });
    db.prepare(
      "INSERT INTO team (id, name, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("team_" + "2".repeat(24), "cinlan", "Cinlan", user.id, "2026-11-12T00:00:00.000Z");
    db.prepare("INSERT INTO team_member (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)").run(
      "team_" + "2".repeat(24),
      user.id,
      "admin",
      "2026-11-12T00:00:00.000Z",
    );
    assert.deepEqual(teamsOfUser(db, user.id), [
      { team_id: "team_" + "2".repeat(24), team: "cinlan", role: "admin" },
    ]);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

function expectDomain(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    assert.equal((err as DomainError).code, code);
    return;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
}

test("meta: team CRUD, membership rules, resolve by id or slug", () => {
  const dir = tempDir();
  try {
    const db = openDatabase({ file: join(dir, "knowledge.db") });
    const sa = createUser(db, { name: "yorker", display_name: "Yorker", is_system_admin: true });
    const alice = createUser(db, { name: "alice", display_name: "Alice" });
    const bob = createUser(db, { name: "bob", display_name: "Bob" });

    // 只有 SA 能建团队，创建者自动成为 TA
    expectDomain(() => createTeam(db, alice, { name: "demo", title: "Demo" }), "FORBIDDEN");
    const team = createTeam(db, sa, { name: "demo", title: "Demo" });
    assert.equal(team.review_mode, "share");
    assert.equal(team.allow_self_approve, true);
    assert.equal(requireTeamRole(db, team.id, sa.id, "admin"), "admin");
    expectDomain(() => requireTeamRole(db, team.id, alice.id, "member"), "NOT_FOUND");
    expectDomain(() => createTeam(db, sa, { name: "demo", title: "Again" }), "ALREADY_EXISTS");

    // 引用解析：id / slug 二选一，冲突 400，未知 404
    assert.equal(resolveTeam(db, { team: "demo" }).id, team.id);
    assert.equal(resolveTeam(db, { team_id: team.id }).name, "demo");
    expectDomain(() => resolveTeam(db, { team_id: team.id, team: "other" }), "INVALID_ARGUMENT");
    expectDomain(() => resolveTeam(db, {}), "INVALID_ARGUMENT");
    expectDomain(() => resolveTeam(db, { team: "nope" }), "NOT_FOUND");
    assert.equal(resolveUserRef(db, { user: "alice" }).id, alice.id);

    // 成员：加入幂等、角色变更、至少留一名 TA
    const m1 = addMember(db, sa, team, alice);
    assert.equal(m1.role, "member");
    assert.equal(addMember(db, sa, team, alice).joined_at, m1.joined_at, "idempotent add");
    assert.equal(addMember(db, sa, team, bob, "admin").role, "admin");

    // sa + bob 两名 admin：移除 bob 后仍留一名
    removeMember(db, sa, team, bob);
    assert.equal(listMembers(db, alice, team).length, 2);
    assert.equal(addMember(db, sa, team, bob).role, "member", "re-add as member");
    assert.equal(addMember(db, sa, team, alice).role, "member", "幂等不改角色");

    // sa 把 alice 提为 admin，此后 alice 才能反过来降 sa
    assert.equal(setMemberRole(db, sa, team, alice, "admin").role, "admin");
    // 现在 sa 与 alice 是 admin：alice 可以把 sa 降为 member
    assert.equal(setMemberRole(db, alice, team, sa, "member").role, "member");
    // alice 是唯一 admin：自我降级、自我移除都必须被拒
    expectDomain(() => setMemberRole(db, alice, team, alice, "member"), "INVALID_ARGUMENT");
    expectDomain(() => removeMember(db, alice, team, alice), "INVALID_ARGUMENT");
    assert.equal(listMembers(db, bob, team).length, 3, "members may list");
    expectDomain(() => updateTeam(db, bob, team, { title: "x" }), "FORBIDDEN");

    // 团队外的人看不到团队
    const carol = createUser(db, { name: "carol", display_name: "Carol" });
    expectDomain(() => requireTeamRole(db, team.id, carol.id, "member"), "NOT_FOUND");
    expectDomain(() => listMembers(db, carol, team), "NOT_FOUND");
    assert.deepEqual(listTeams(db, carol, {}).items, []);
    assert.equal(listTeams(db, alice, {}).items.length, 1);
    assert.equal(listTeams(db, sa, {}).items.length, 1);

    // update
    const updated = updateTeam(db, alice, team, { title: "Demo 2", review_mode: "all" });
    assert.equal(updated.title, "Demo 2");
    assert.equal(getTeamByName(db, "demo")!.review_mode, "all");
    expectDomain(() => updateTeam(db, bob, team, { title: "x" }), "FORBIDDEN"); // bob 仍是 member
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("meta: team delete blocked by assets and agents", () => {
  const dir = tempDir();
  try {
    const db = openDatabase({ file: join(dir, "knowledge.db") });
    const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
    const team = createTeam(db, sa, { name: "demo", title: "Demo" });
    const other = createTeam(db, sa, { name: "empty", title: "Empty" });

    db.prepare(
      `INSERT INTO asset (id, team_id, type, title, summary, owner_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(newId("ast"), team.id, "memory", "t", "", sa.id, "t", "t");
    expectDomain(() => deleteTeam(db, sa, team), "INVALID_ARGUMENT");

    db.prepare("DELETE FROM asset").run();
    createAgent(db, sa, team, { name: "cc", host: "claude-code" });
    expectDomain(() => deleteTeam(db, sa, team), "INVALID_ARGUMENT");

    deleteTeam(db, sa, other);
    assert.equal(getTeamByName(db, "empty"), null);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("meta: agent ensure takes-or-creates and copies the team template", () => {
  const dir = tempDir();
  try {
    const db = openDatabase({ file: join(dir, "knowledge.db") });
    const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
    const member = createUser(db, { name: "m", display_name: "M" });
    const team = createTeam(db, sa, { name: "demo", title: "Demo" });
    addMember(db, sa, team, member);

    // 模板 Agent 由 TA 建，绑定两条资产
    const template = createAgent(db, sa, team, { name: "template", host: "dsh", is_template: true });
    for (let i = 0; i < 2; i++) {
      const asset = {
        id: newId("ast"),
        team_id: team.id,
        type: "memory",
        title: `a${i}`,
        summary: "",
        owner_user_id: sa.id,
        created_at: "t",
        updated_at: "t",
      };
      db.prepare(
        `INSERT INTO asset (id, team_id, type, title, summary, owner_user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(asset.id, asset.team_id, asset.type, asset.title, asset.summary, asset.owner_user_id, "t", "t");
      db.prepare(
        `INSERT INTO agent_asset (agent_id, asset_id, priority, injection_mode, source, bound_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(template.id, asset.id, 100 + i, "inject", "manual", sa.id, "t");
    }

    expectDomain(() => setDefaultTemplate(db, member, team, template), "FORBIDDEN");
    setDefaultTemplate(db, sa, team, template);
    assert.equal(getDefaultTemplate(db, member, team)!.id, template.id);

    // 成员第一次 ensure：创建并拷贝模板配装
    const first = ensureAgent(db, member, team, { name: "cc-ly", host: "claude-code" });
    assert.equal(first.created, true);
    assert.equal(first.template_applied, 2);
    const copied = db
      .prepare("SELECT asset_id, source, priority FROM agent_asset WHERE agent_id = ? ORDER BY priority")
      .all(first.agent.id) as unknown as { asset_id: string; source: string; priority: number }[];
    assert.equal(copied.length, 2);
    assert.ok(copied.every((r) => r.source === "template"));

    // 第二次 ensure：取到同一条，只刷新 host / last_seen_at
    db.prepare("UPDATE agent SET last_seen_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", first.agent.id);
    const second = ensureAgent(db, member, team, { name: "cc-ly", host: "gemini-cli" });
    assert.equal(second.created, false);
    assert.equal(second.template_applied, 0);
    assert.equal(second.agent.id, first.agent.id);
    assert.equal(second.agent.host, "gemini-cli");
    assert.notEqual(second.agent.last_seen_at, "2000-01-01T00:00:00.000Z", "last_seen_at refreshed");

    // 非成员不能 ensure
    const outsider = createUser(db, { name: "out", display_name: "Out" });
    expectDomain(() => ensureAgent(db, outsider, team, { name: "x", host: "dsh" }), "NOT_FOUND");

    // 列表：成员只看自己的；TA 看全团队
    createAgent(db, sa, team, { name: "sa-agent", host: "dsh" });
    assert.equal(listAgents(db, member, team, {}).items.length, 1);
    assert.equal(listAgents(db, sa, team, {}).items.length, 3);
    archiveAgent(db, sa, template);
    assert.equal(listAgents(db, sa, team, {}).items.length, 2);
    assert.equal(listAgents(db, sa, team, { include_archived: true }).items.length, 3);
    assert.equal(getDefaultTemplate(db, sa, team), null, "archived template is treated as absent");

    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("meta: user key list / revoke authorization and user disable", () => {
  const dir = tempDir();
  try {
    const db = openDatabase({ file: join(dir, "knowledge.db") });
    const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
    const alice = createUser(db, { name: "alice", display_name: "Alice" });
    const bob = createUser(db, { name: "bob", display_name: "Bob" });

    const k = createUserKey(db, alice.id, "laptop");
    assert.equal(listUserKeys(db, alice, alice).length, 1);
    assert.equal(listUserKeys(db, sa, alice).length, 1, "SA may inspect");
    expectDomain(() => listUserKeys(db, bob, alice), "FORBIDDEN");
    expectDomain(() => revokeUserKey(db, bob, alice, k.id), "FORBIDDEN");

    revokeUserKey(db, sa, alice, k.id);
    revokeUserKey(db, sa, alice, k.id); // 幂等
    assert.deepEqual(verifyUserKey(db, k.key), { ok: false, reason: "revoked" });
    expectDomain(() => revokeUserKey(db, sa, alice, "key_" + "0".repeat(24)), "NOT_FOUND");

    // 禁用后名下全部 key 立即失效
    const k2 = createUserKey(db, alice.id, "phone");
    assert.equal(verifyUserKey(db, k2.key).ok, true);
    setUserDisabled(db, sa, alice, true);
    assert.deepEqual(verifyUserKey(db, k2.key), { ok: false, reason: "disabled" });
    expectDomain(() => setUserDisabled(db, sa, sa, true), "INVALID_ARGUMENT");
    expectDomain(() => setUserDisabled(db, alice, bob, true), "FORBIDDEN");

    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("stableStringify is key-order independent", () => {  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("S3: FTS5 trigram — 2-char CJK falls back to LIKE, seq survives VACUUM INTO", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "knowledge.db");
    const db = openDatabase({ file });
    const user = createUser(db, { name: "ly", display_name: "LY" });
    db.prepare(
      "INSERT INTO team (id, name, title, created_by, created_at) VALUES (?,?,?,?,?)",
    ).run("team_" + "3".repeat(24), "cinlan", "Cinlan", user.id, "2026-11-12T00:00:00.000Z");

    const insertAsset = db.prepare(
      `INSERT INTO asset (id, team_id, type, title, summary, owner_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    insertAsset.run("ast_" + "4".repeat(24), "team_" + "3".repeat(24), "memory", "发版检查清单", "", user.id, "t", "t");
    insertAsset.run("ast_" + "5".repeat(24), "team_" + "3".repeat(24), "memory", "其他资产", "", user.id, "t", "t");

    const rows = db.prepare("SELECT seq, id FROM asset ORDER BY seq").all() as { seq: number; id: string }[];
    assert.equal(rows.length, 2);

    // 索引：rowid = asset.seq，正文写进 FTS
    db.prepare("INSERT INTO asset_fts (rowid, title, tags, summary, body) VALUES (?,?,?,?,?)").run(
      rows[0]!.seq,
      "发版检查清单",
      "[]",
      "",
      "发布前先跑 e2e，失败则回滚",
    );

    // 3 字及以上走 trigram MATCH
    const byMatch = db.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?").all("发版检查") as {
      rowid: number;
    }[];
    assert.deepEqual(byMatch.map((r) => r.rowid), [rows[0]!.seq]);

    // 2 字中文 trigram 匹配不到 —— 正是需要 LIKE 兜底的场景
    const byTwoChar = db.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?").all("回滚") as {
      rowid: number;
    }[];
    assert.deepEqual(byTwoChar, []);

    const byLike = db
      .prepare("SELECT rowid FROM asset_fts WHERE title LIKE ? OR body LIKE ?")
      .all("%回滚%", "%回滚%") as { rowid: number }[];
    assert.deepEqual(byLike.map((r) => r.rowid), [rows[0]!.seq]);

    // VACUUM INTO 后 seq 与 rowid 都不变
    const backupFile = join(dir, "backup.db");
    backupTo(db, backupFile);
    const copy = new DatabaseSync(backupFile);
    const backedUp = copy.prepare("SELECT seq, id FROM asset ORDER BY seq").all() as { seq: number; id: string }[];
    assert.deepEqual(backedUp, rows);
    const ftsAfter = copy.prepare("SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?").all("发版检查") as {
      rowid: number;
    }[];
    assert.deepEqual(ftsAfter.map((r) => r.rowid), [rows[0]!.seq]);
    copy.close();

    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
