import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createAgent, createTeam, createUser, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import {
  applyStatus,
  applyVisibility,
  checkAcl,
  createAsset,
  getAssetDetail,
  getHistory,
  grantAcl,
  listAcl,
  listAssets,
  revokeAcl,
} from "../src/asset.js";
import { bindAsset, resolveLoadout } from "../src/loadout.js";
import { searchAssets } from "../src/search.js";
import type { Principal } from "../src/access.js";

/**
 * T6 不泄露（docs/sop.md）：不可见资产的 get / search / bind / acl 全是 NOT_FOUND，
 * 而且与"这个 id 根本不存在"报得一模一样；按 Owner 建立的同名私有 skill 互不可见。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-leak-"));
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

/** 抛出的 DomainError 的 code + message；没抛就是 null。 */
function thrown(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    return { code: (err as DomainError).code, message: (err as DomainError).message };
  }
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: 发版流程\n---\n\n# Deploy\n\n${body}`;
}

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  team: ReturnType<typeof createTeam>;
  root: User;
  alice: User;
  bob: User;
  carol: User;
  outsider: User;
  aliceAgent: string;
  bobAgent: string;
  outsiderAgent: string;
}

function fixture(dir: string): Fixture {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const root = createUser(db, { name: "root", display_name: "Root", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const carol = createUser(db, { name: "carol", display_name: "Carol" });
  const outsider = createUser(db, { name: "out", display_name: "Out" });
  const team = createTeam(db, root, { name: "demo", title: "Demo" });
  addMember(db, root, team, alice);
  addMember(db, root, team, bob);
  addMember(db, root, team, carol);
  const other = createTeam(db, root, { name: "other", title: "Other" });
  addMember(db, root, other, outsider, "admin");
  const aliceAgent = createAgent(db, alice, team, { name: "a-agent", host: "dsh" }).id;
  const bobAgent = createAgent(db, bob, team, { name: "b-agent", host: "dsh" }).id;
  const outsiderAgent = createAgent(db, outsider, other, { name: "o-agent", host: "dsh" }).id;
  return { db, team, root, alice, bob, carol, outsider, aliceAgent, bobAgent, outsiderAgent };
}

const MISSING = "ast_000000000000000000000000";

test("T6: invisible asset — get / search / bind / acl are NOT_FOUND, same as a missing id", () => {
  const dir = tempDir();
  try {
    const f = fixture(dir);
    const { db, team, alice, bob, carol, outsider } = f;
    const make = (title: string) =>
      createAsset(db, as(alice), team.id, { type: "memory", title, content: "机密回滚步骤" }).asset;

    // bob（同团队普通成员）看不见的五种情形
    const priv = make("机密回滚 private");
    const restricted = applyVisibility(
      db,
      make("机密回滚 restricted"),
      { visibility: "restricted", acl: [{ subject_type: "user", subject_id: carol.id, permission: "read" }] },
      alice.id,
    );
    const agentOnly = applyVisibility(db, make("机密回滚 agent"), { visibility: "agent", acl: [] }, alice.id);
    bindAsset(db, as(alice), { agent_id: f.aliceAgent, asset_id: agentOnly.id });
    const draft = applyVisibility(db, make("机密回滚 draft"), { visibility: "team", acl: [] }, alice.id);
    db.prepare("UPDATE asset SET status = 'draft' WHERE id = ?").run(draft.id);
    const archived = applyStatus(db, applyVisibility(db, make("机密回滚 archived"), { visibility: "team", acl: [] }, alice.id), "archived");
    // 对照：团队可见的一条，bob 搜得到、团队外的人搜不到
    const shared = applyVisibility(db, make("机密回滚 team"), { visibility: "team", acl: [] }, alice.id);

    const hidden = [priv, restricted, agentOnly, draft, archived];
    const probes: { who: string; principal: Principal; agent: string; assets: typeof hidden }[] = [
      { who: "bob", principal: as(bob), agent: f.bobAgent, assets: hidden },
      { who: "outsider", principal: as(outsider), agent: f.outsiderAgent, assets: [...hidden, shared] },
    ];
    const aclBefore = db.prepare("SELECT COUNT(*) AS n FROM acl").get() as { n: number };
    const boundBefore = db.prepare("SELECT COUNT(*) AS n FROM agent_asset").get() as { n: number };

    for (const { who, principal, agent, assets } of probes) {
      const withAgent: Principal = { user: principal.user, agent: { id: agent, owner_user_id: principal.user.id } };
      for (const asset of assets) {
        const where = `${who} → ${asset.title}`;
        // 每个入口对"看不见的 id"与"不存在的 id"各调一次：code 与 message 都必须一样
        const entries: [string, (id: string) => unknown][] = [
          ["asset/get", (id) => getAssetDetail(db, principal, id)],
          ["asset/get（带 Agent）", (id) => getAssetDetail(db, withAgent, id)],
          ["asset/history", (id) => getHistory(db, principal, id)],
          ["loadout/bind", (id) => bindAsset(db, principal, { agent_id: agent, asset_id: id })],
          ["acl/list", (id) => listAcl(db, principal, { ...asset, id })],
          ["acl/grant", (id) => grantAcl(db, principal, { ...asset, id }, { subject_type: "user", subject_id: principal.user.id, permission: "manage" })],
          ["acl/revoke", (id) => revokeAcl(db, principal, { ...asset, id }, { subject_type: "user", subject_id: carol.id })],
          ["acl/check", (id) => checkAcl(db, principal, id)],
          ["acl/check（带 Agent）", (id) => checkAcl(db, principal, id, agent)],
        ];
        for (const [entry, call] of entries) {
          const got = thrown(() => call(asset.id));
          assert.equal(got?.code, "NOT_FOUND", `${entry}: ${where}`);
          assert.deepEqual(got, thrown(() => call(MISSING)), `${entry} 与不存在的 id 不可区分: ${where}`);
        }
        // 列表与检索：不出现
        assert.ok(!listAssets(db, principal, {}).items.some((a) => a.id === asset.id), `asset/list: ${where}`);
        assert.ok(!listAssets(db, withAgent, {}).items.some((a) => a.id === asset.id), `asset/list（带 Agent）: ${where}`);
        for (const query of ["回滚", "机密回滚", "机密回滚步骤"]) {
          assert.ok(!searchAssets(db, principal, { query }).hits.some((h) => h.asset_id === asset.id), `asset/search ${query}: ${where}`);
          assert.ok(!searchAssets(db, withAgent, { query }).hits.some((h) => h.asset_id === asset.id), `asset/search ${query}（带 Agent）: ${where}`);
        }
      }
    }
    // 探测没有留下任何副作用
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM acl").get(), aclBefore);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM agent_asset").get(), boundBefore);
    // 对照组：检索本身是通的
    assert.deepEqual(searchAssets(db, as(bob), { query: "机密回滚" }).hits.map((h) => h.asset_id), [shared.id]);
    assert.equal(searchAssets(db, as(outsider), { query: "机密回滚" }).hits.length, 0);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("T6: same-name private skills of different owners do not leak into each other", () => {
  const dir = tempDir();
  try {
    const f = fixture(dir);
    const { db, team, root, alice, bob } = f;
    const mine = createAsset(db, as(alice), team.id, {
      type: "skill",
      name: "deploy-release",
      title: "Alice 的发版",
      content: skillMd("deploy-release", "alice 的私有步骤"),
    });
    // 第二个 Owner 用同名建得出来：报 409 就等于告诉他"别人已有一个同名私有 skill"
    const theirs = createAsset(db, as(bob), team.id, {
      type: "skill",
      name: "deploy-release",
      title: "Bob 的发版",
      content: skillMd("deploy-release", "bob 的私有步骤"),
    });
    assert.notEqual(theirs.asset.id, mine.asset.id);

    const sides = [
      { who: alice, agent: f.aliceAgent, own: mine, other: theirs, secret: "bob 的私有步骤" },
      { who: bob, agent: f.bobAgent, own: theirs, other: mine, secret: "alice 的私有步骤" },
    ];
    for (const { who, agent, own, other, secret } of sides) {
      const where = who.name;
      // 列表 / 检索：只有自己的那一条
      assert.deepEqual(listAssets(db, as(who), { type: "skill" }).items.map((a) => a.id), [own.asset.id], where);
      for (const query of ["deploy-release", "私有步骤", "发版"]) {
        const hits = searchAssets(db, as(who), { query }).hits;
        assert.deepEqual(hits.map((h) => h.asset_id), [own.asset.id], `search ${query}: ${where}`);
        assert.ok(!hits.some((h) => h.snippet.includes(secret)), `snippet: ${where}`);
      }
      // 对方那条：打开、绑定、自查都是 NOT_FOUND
      assert.equal(thrown(() => getAssetDetail(db, as(who), other.asset.id))?.code, "NOT_FOUND", where);
      assert.equal(thrown(() => bindAsset(db, as(who), { agent_id: agent, asset_id: other.asset.id }))?.code, "NOT_FOUND", where);
      assert.equal(thrown(() => checkAcl(db, as(who), other.asset.id))?.code, "NOT_FOUND", where);
      // 配装：物化清单里只有自己的那一份
      bindAsset(db, as(who), { agent_id: agent, asset_id: own.asset.id });
      const res = resolveLoadout(db, as(who), { agent_id: agent });
      assert.deepEqual(
        res.skills.map((s) => [s.asset_id, s.name, s.content_hash]),
        [[own.asset.id, "deploy-release", own.version.content_hash]],
        where,
      );
      assert.equal(res.skipped.length, 0, where);
    }
    assert.notEqual(mine.version.content_hash, theirs.version.content_hash);
    // 团队 Admin 也看不到任何一条私有 skill
    assert.equal(listAssets(db, as(root), { type: "skill" }).items.length, 0);
    assert.equal(searchAssets(db, as(root), { query: "deploy-release" }).hits.length, 0);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
