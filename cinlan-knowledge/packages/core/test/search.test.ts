import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createTeam, createUser, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import { applyStatus, applyVisibility, createAsset, planVisibility } from "../src/asset.js";
import { searchAssets } from "../src/search.js";
import type { Principal } from "../src/access.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-search-"));
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

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  alice: User;
  bob: User;
  outsider: User;
  team: ReturnType<typeof createTeam>;
}

function fixture(dir: string): Fixture {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const outsider = createUser(db, { name: "out", display_name: "Out" });
  const team = createTeam(db, sa, { name: "demo", title: "Demo" });
  addMember(db, sa, team, alice, "admin");
  addMember(db, sa, team, bob);
  return { db, alice, bob, outsider, team };
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

function make(
  db: Fixture["db"],
  owner: User,
  team: ReturnType<typeof createTeam>,
  title: string,
  content: string,
  share: boolean,
  tags: string[] = [],
) {
  const { asset } = createAsset(db, as(owner), team.id, { type: "memory", title, content, tags });
  if (share) {
    const plan = planVisibility(db, as(owner), asset, { visibility: "team" });
    applyVisibility(db, asset, plan.plan, owner.id);
  }
  return asset;
}

test("search: 2-char CJK falls back to LIKE, 3+ CJK and English use trigram", () => {
  const dir = tempDir();
  try {
    const { db, alice, team } = fixture(dir);
    make(db, alice, team, "回滚流程", "回滚前先备份数据库。", true);
    make(db, alice, team, "发版检查清单", "发布之前先跑 e2e。", true);
    make(db, alice, team, "Deploy Checklist", "Run E2E before deploy.", true);

    // 2 字中文：trigram 不可用，走 LIKE 兜底
    const two = searchAssets(db, as(alice), { query: "回滚" });
    assert.deepEqual(two.hits.map((h) => h.title), ["回滚流程"]);
    assert.ok(two.hits[0]!.snippet.includes("备份数据库"));

    // 3 字以上中文：trigram 命中子串
    const cjk = searchAssets(db, as(alice), { query: "发版检查" });
    assert.deepEqual(cjk.hits.map((h) => h.title), ["发版检查清单"]);

    // 英文大小写不敏感
    const lower = searchAssets(db, as(alice), { query: "deploy" });
    assert.deepEqual(lower.hits.map((h) => h.title), ["Deploy Checklist"]);
    const upper = searchAssets(db, as(alice), { query: "DEPLOY" });
    assert.deepEqual(upper.hits.map((h) => h.title), ["Deploy Checklist"]);

    // 正文命中：e2e 出现在两条资产里，标题权重更高
    const body = searchAssets(db, as(alice), { query: "e2e" });
    assert.deepEqual(body.hits.map((h) => h.title).sort(), ["Deploy Checklist", "发版检查清单"]);

    // 多词 AND
    const multi = searchAssets(db, as(alice), { query: "Deploy E2E" });
    assert.deepEqual(multi.hits.map((h) => h.title), ["Deploy Checklist"]);
    const none = searchAssets(db, as(alice), { query: "Deploy 回滚" });
    assert.equal(none.hits.length, 0);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("search: deprecated is downweighted and marked; expired/archived/invisible never appear", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team } = fixture(dir);
    const fresh = make(db, alice, team, "回滚流程", "当前有效的回滚步骤。", true);
    const old = make(db, alice, team, "回滚流程（旧）", "旧的回滚步骤。", true);
    applyStatus(db, old, "deprecated");
    const archived = make(db, alice, team, "回滚归档", "已归档的回滚。", true);
    applyStatus(db, archived, "archived");
    const expired = make(db, alice, team, "回滚过期", "过期的回滚。", true);
    db.prepare("UPDATE asset SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.id);
    const bobPrivate = make(db, bob, team, "回滚私密", "bob 的回滚。", false);
    const alicePrivate = make(db, alice, team, "回滚草稿", "alice 还没共享的回滚。", false);

    const res = searchAssets(db, as(alice), { query: "回滚" });
    const titles = res.hits.map((h) => h.title);
    assert.ok(titles.includes(fresh.title));
    assert.ok(titles.includes(old.title), "deprecated 仍可检索");
    assert.ok(!titles.includes(archived.title), "archived 不出现");
    assert.ok(!titles.includes(expired.title), "过期不出现");
    assert.ok(!titles.includes(bobPrivate.title), "不可见不出现");
    assert.ok(titles.includes(alicePrivate.title), "自己的私有资产可检索");

    // 降权：同标题同得分，deprecated 分数减半且排在后面
    const oldHit = res.hits.find((h) => h.asset_id === old.id)!;
    const freshHit = res.hits.find((h) => h.asset_id === fresh.id)!;
    assert.equal(oldHit.deprecated, true);
    assert.equal(freshHit.deprecated, false);
    assert.equal(oldHit.score, freshHit.score / 2);
    assert.ok(res.hits.indexOf(freshHit) < res.hits.indexOf(oldHit));

    // 团队外的人搜不到任何团队资产
    const outsider = createUser(db, { name: "out2", display_name: "Out2" });
    assert.equal(searchAssets(db, as(outsider), { query: "回滚" }).hits.length, 0);
    // bob 能看到团队共享，但搜不到 alice 的私有
    const bobs = searchAssets(db, as(bob), { query: "回滚" }).hits.map((h) => h.title);
    assert.ok(bobs.includes(fresh.title));
    assert.ok(!bobs.includes(alicePrivate.title));
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("search: filters, limits and argument validation", () => {
  const dir = tempDir();
  try {
    const { db, alice, team } = fixture(dir);
    make(db, alice, team, "回滚流程", "文本", true);
    const { asset: skill } = createAsset(db, as(alice), team.id, {
      type: "skill",
      name: "rollback",
      title: "回滚 skill",
      content: "---\nname: rollback\ndescription: 回滚\n---\n\n回滚步骤",
    });
    const plan = planVisibility(db, as(alice), skill, { visibility: "team" });
    applyVisibility(db, skill, plan.plan, alice.id);
    make(db, alice, team, "回滚带标签", "文本", true, ["ops"]);

    assert.equal(searchAssets(db, as(alice), { query: "回滚" }).hits.length, 3);
    assert.deepEqual(
      searchAssets(db, as(alice), { query: "回滚", types: ["skill"] }).hits.map((h) => h.type),
      ["skill"],
    );
    assert.deepEqual(
      searchAssets(db, as(alice), { query: "回滚", tags: ["ops"] }).hits.map((h) => h.title),
      ["回滚带标签"],
    );
    assert.equal(searchAssets(db, as(alice), { query: "回滚", limit: 1 }).hits.length, 1);

    expectDomain(() => searchAssets(db, as(alice), {}), "INVALID_ARGUMENT");
    expectDomain(() => searchAssets(db, as(alice), { query: "   " }), "INVALID_ARGUMENT");
    expectDomain(() => searchAssets(db, as(alice), { query: "回滚", limit: 21 }), "INVALID_ARGUMENT");
    // P4 起 wiki / codegraph 是合法 types（p4.test.ts 覆盖）；这里用真非法值钉住校验本身
    expectDomain(() => searchAssets(db, as(alice), { query: "回滚", types: ["bogus" as never] }), "INVALID_ARGUMENT");
    // LIKE 通配符被转义，不会变成全表匹配
    assert.equal(searchAssets(db, as(alice), { query: "%" }).hits.length, 0);
    assert.equal(searchAssets(db, as(alice), { query: "_" }).hits.length, 0);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
