import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createAgent, createTeam, createUser, type User } from "../src/meta.js";
import { createAsset } from "../src/asset.js";
import { DomainError } from "../src/errors.js";
import { listAudit, writeAudit } from "../src/audit.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-audit-"));
}

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

function as(user: User): { id: string; is_system_admin: boolean } {
  return { id: user.id, is_system_admin: user.is_system_admin };
}

function fixture(dir: string) {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const carol = createUser(db, { name: "carol", display_name: "Carol" });
  const demo = createTeam(db, sa, { name: "demo", title: "Demo" });
  const other = createTeam(db, sa, { name: "other", title: "Other" });
  addMember(db, sa, demo, alice, "admin");
  addMember(db, sa, demo, bob);
  addMember(db, sa, other, carol, "admin");
  const demoAgent = createAgent(db, alice, demo, { name: "cc-alice", host: "claude-code" });
  const otherAgent = createAgent(db, carol, other, { name: "cc-carol", host: "claude-code" });
  const demoAsset = createAsset(db, { user: { id: alice.id } }, demo.id, { type: "memory", title: "demo", content: "d" }).asset;
  const otherAsset = createAsset(db, { user: { id: carol.id } }, other.id, { type: "memory", title: "other", content: "o" }).asset;
  return { db, sa, alice, bob, carol, demo, other, demoAgent, otherAgent, demoAsset, otherAsset };
}

test("audit: list derives team scope from the target, SA sees all", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, bob, carol, demo, other, demoAgent, otherAgent, demoAsset, otherAsset } = fixture(dir);
    writeAudit(db, { action: "asset/update", actor_user_id: alice.id, target_type: "asset", target_id: demoAsset.id, detail: { version: { from: 1, to: 2 } } });
    writeAudit(db, { action: "asset/update", actor_user_id: carol.id, target_type: "asset", target_id: otherAsset.id });
    writeAudit(db, { action: "loadout/bind", actor_user_id: alice.id, target_type: "agent", target_id: demoAgent.id });
    writeAudit(db, { action: "loadout/bind", actor_user_id: carol.id, target_type: "agent", target_id: otherAgent.id });
    writeAudit(db, { action: "team/update", actor_user_id: alice.id, target_type: "team", target_id: demo.id });
    writeAudit(db, { action: "user/create", actor_user_id: sa.id, target_type: "user", target_id: bob.id });
    writeAudit(db, { action: "system/backup", actor_user_id: sa.id });

    // TA 只看到目标落在本团队的记录：两条 asset/agent + 一条 team；user 目标与无目标仅 SA 可见
    const byTa = listAudit(db, as(alice), { team_id: demo.id });
    assert.deepEqual(
      byTa.items.map((r) => r.action).sort(),
      ["asset/update", "loadout/bind", "team/update"],
    );
    assert.ok(byTa.items.every((r) => r.target_type !== "user" && r.target_type !== null));
    assert.equal(byTa.items[0]!.detail !== undefined, true);

    // SA 不带 team：全部；带 team：与 TA 同一边界
    assert.equal(listAudit(db, as(sa), {}).items.length, 7);
    const saScoped = listAudit(db, as(sa), { team: "other" });
    assert.deepEqual(saScoped.items.map((r) => r.action).sort(), ["asset/update", "loadout/bind"]);
    assert.deepEqual(saScoped.items.map((r) => r.target_id).sort(), [otherAgent.id, otherAsset.id].sort());

    // 权限：成员 FORBIDDEN；团队外 NOT_FOUND（不暴露团队存在）；TA 不给 team 参数 INVALID_ARGUMENT
    expectDomain(() => listAudit(db, as(bob), { team_id: demo.id }), "FORBIDDEN");
    expectDomain(() => listAudit(db, as(carol), { team_id: demo.id }), "NOT_FOUND");
    expectDomain(() => listAudit(db, as(alice), {}), "INVALID_ARGUMENT");

    // 过滤：action / actor / target_type / since / until
    assert.deepEqual(
      listAudit(db, as(alice), { team_id: demo.id, action: "asset/update" }).items.map((r) => r.target_id),
      [demoAsset.id],
    );
    assert.equal(listAudit(db, as(sa), { actor_user_id: carol.id }).items.length, 2);
    assert.equal(listAudit(db, as(sa), { target_type: "agent" }).items.length, 2);
    assert.equal(listAudit(db, as(sa), { since: "2999-01-01T00:00:00.000Z" }).items.length, 0);
    assert.equal(listAudit(db, as(sa), { until: "2000-01-01T00:00:00.000Z" }).items.length, 0);
    expectDomain(() => listAudit(db, as(sa), { since: "not-a-time" }), "INVALID_ARGUMENT");

    // 分页：新的在前，limit 生效，cursor 翻页不丢行
    const page1 = listAudit(db, as(sa), { limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.notEqual(page1.next_cursor, "");
    assert.ok(page1.items[0]!.id > page1.items[2]!.id, "按 id 倒序");
    const page2 = listAudit(db, as(sa), { limit: 3, cursor: page1.next_cursor });
    assert.equal(page2.items.length, 3);
    const page3 = listAudit(db, as(sa), { limit: 3, cursor: page2.next_cursor });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.next_cursor, "");

    expectDomain(() => listAudit(db, as(sa), { limit: 0 }), "INVALID_ARGUMENT");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
