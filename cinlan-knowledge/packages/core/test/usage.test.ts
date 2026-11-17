import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createAgent, createTeam, createUser, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import { createAsset, planVisibility, applyVisibility } from "../src/asset.js";
import { pruneUsage, recordOpened, reportUsage, usageSummary } from "../src/usage.js";
import { writeAudit } from "../src/audit.js";
import type { Principal } from "../src/access.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-usage-"));
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

function as(user: User): Principal {
  return { user: { id: user.id } };
}

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  sa: User;
  alice: User;
  bob: User;
  outsider: User;
  team: ReturnType<typeof createTeam>;
  agent: ReturnType<typeof createAgent>;
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
  const agent = createAgent(db, alice, team, { name: "cc-ly", host: "claude-code" });
  return { db, sa, alice, bob, outsider, team, agent };
}

function usageRow(
  db: Fixture["db"],
  asset_id: string,
  agent_id: string,
): { day: string; injected: number; opened: number } | undefined {
  return db
    .prepare("SELECT day, injected, opened FROM usage_daily WHERE asset_id = ? AND agent_id = ?")
    .get(asset_id, agent_id) as { day: string; injected: number; opened: number } | undefined;
}

test("usage: report aggregates by day, bumps counters, skips unreadable", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, outsider, team, agent } = fixture(dir);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });

    const out = reportUsage(db, as(alice), {
      agent_id: agent.id,
      events: [
        { asset_id: asset.id, version: 1, kind: "injected" },
        { asset_id: asset.id, version: 1, kind: "injected" },
        { asset_id: asset.id, version: 1, kind: "opened" },
      ],
    });
    assert.equal(out.recorded, 3);
    const row = usageRow(db, asset.id, agent.id)!;
    assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.injected, 2);
    assert.equal(row.opened, 1);

    const counters = db.prepare("SELECT usage_count, last_used_at FROM asset WHERE id = ?").get(asset.id) as {
      usage_count: number;
      last_used_at: string | null;
    };
    assert.equal(counters.usage_count, 3);
    assert.ok(counters.last_used_at !== null);

    // bob 在本团队但不是这个 Agent 的 Owner：FORBIDDEN；团队外：NOT_FOUND（不暴露 Agent 存在）
    expectDomain(
      () => reportUsage(db, as(bob), { agent_id: agent.id, events: [{ asset_id: asset.id, version: 1, kind: "opened" }] }),
      "FORBIDDEN",
    );
    expectDomain(
      () =>
        reportUsage(db, as(outsider), {
          agent_id: agent.id,
          events: [{ asset_id: asset.id, version: 1, kind: "opened" }],
        }),
      "NOT_FOUND",
    );

    // TA 可以替本团队 Agent 上报
    const byTa = reportUsage(db, as(alice), {
      agent_id: agent.id,
      events: [{ asset_id: asset.id, version: 1, kind: "opened" }],
    });
    assert.equal(byTa.recorded, 1);

    // 不存在的资产：静默跳过，不报错也不泄露存在性
    const skipped = reportUsage(db, as(alice), {
      agent_id: agent.id,
      events: [
        { asset_id: "ast_000000000000000000000000", version: 1, kind: "injected" },
        { asset_id: asset.id, version: 1, kind: "injected" },
      ],
    });
    assert.equal(skipped.recorded, 1);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("usage: validation, opened hook and 180-day retention", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team, agent } = fixture(dir);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });
    const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
    applyVisibility(db, asset, plan.plan, alice.id);

    // 参数
    expectDomain(() => reportUsage(db, as(alice), { agent_id: agent.id }), "INVALID_ARGUMENT");
    expectDomain(() => reportUsage(db, as(alice), { agent_id: agent.id, events: [] }), "INVALID_ARGUMENT");
    expectDomain(
      () => reportUsage(db, as(alice), { agent_id: agent.id, events: [{ asset_id: asset.id, version: 0, kind: "injected" }] }),
      "INVALID_ARGUMENT",
    );
    expectDomain(
      () => reportUsage(db, as(alice), { agent_id: agent.id, events: [{ asset_id: asset.id, version: 1, kind: "view" }] }),
      "INVALID_ARGUMENT",
    );
    expectDomain(() => reportUsage(db, as(alice), { events: [] }), "INVALID_ARGUMENT");
    expectDomain(
      () => reportUsage(db, as(alice), { agent_id: "agt_000000000000000000000000", events: [{ asset_id: asset.id, version: 1, kind: "injected" }] }),
      "NOT_FOUND",
    );

    // opened 钩子：bob 看不到 alice 的私有资产 → false；团队共享后 → 记账成功
    const priv = createAsset(db, as(alice), team.id, { type: "memory", title: "P", content: "p" }).asset;
    assert.equal(recordOpened(db, agent.id, priv.id), true, "Agent 以 Owner 身份读取");
    assert.equal(recordOpened(db, "agt_000000000000000000000000", priv.id), false, "未知 Agent 静默失败");
    assert.equal(usageRow(db, priv.id, agent.id)!.opened, 1);

    // 保留期：180 天之前的数据被清掉，边界内的保留
    db.prepare(
      `INSERT INTO usage_daily (day, asset_id, agent_id, injected, opened)
       VALUES ('2000-01-01', ?, ?, 5, 0)`,
    ).run(asset.id, agent.id);
    const removed = pruneUsage(db);
    assert.equal(removed, 1);
    assert.equal(usageRow(db, asset.id, agent.id), undefined, "旧数据已清理");
    assert.equal(usageRow(db, priv.id, agent.id)!.opened, 1, "新数据保留");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("usage: summary groups by asset / agent / cold within the window, TA-scoped", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, bob, outsider, team, agent } = fixture(dir);
    const shared = createAsset(db, as(alice), team.id, { type: "memory", title: "共享记忆", content: "c" }).asset;
    applyVisibility(db, shared, planVisibility(db, as(alice), shared, { visibility: "team" }).plan, alice.id);
    const priv = createAsset(db, as(alice), team.id, { type: "memory", title: "私有记忆", content: "p" }).asset;
    const cold = createAsset(db, as(alice), team.id, { type: "memory", title: "没人用", content: "x" }).asset;
    applyVisibility(db, cold, planVisibility(db, as(alice), cold, { visibility: "team" }).plan, alice.id);
    createAsset(db, as(bob), team.id, { type: "memory", title: "bob 私有", content: "b" });

    reportUsage(db, as(alice), {
      agent_id: agent.id,
      events: [
        { asset_id: shared.id, version: 1, kind: "injected" },
        { asset_id: shared.id, version: 1, kind: "injected" },
        { asset_id: priv.id, version: 1, kind: "opened" },
      ],
    });
    // 窗口外的旧数据不计数
    db.prepare(
      "INSERT INTO usage_daily (day, asset_id, agent_id, injected, opened) VALUES ('2000-01-01', ?, ?, 9, 9)",
    ).run(shared.id, agent.id);

    const out = usageSummary(db, alice, { team_id: team.id, days: 90 });
    assert.equal(out.days, 90);
    assert.match(out.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(out.to, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(
      out.by_asset.map((r) => [r.asset_id, r.injected, r.opened]),
      [
        [shared.id, 2, 0],
        [priv.id, 0, 1],
      ],
    );
    assert.equal(out.by_asset[0]!.title, "共享记忆");
    assert.deepEqual(
      out.by_agent.map((r) => [r.agent_id, r.host, r.injected, r.opened]),
      [[agent.id, "claude-code", 2, 1]],
    );
    // 冷资产 = 团队可见、窗口内零用量；private（含他人 private）不进
    assert.deepEqual(out.cold.map((r) => r.asset_id), [cold.id]);

    // group_by 只保留对应一组，其余置空
    const onlyAgent = usageSummary(db, alice, { team_id: team.id, group_by: "agent" });
    assert.equal(onlyAgent.by_asset.length, 0);
    assert.equal(onlyAgent.by_agent.length, 1);
    assert.equal(onlyAgent.agents_stale.length, 0, "fixture 的 Agent 有用量，不进 stale");

    // 建一个零用量的 Agent → 进 agents_stale
    const stale = createAgent(db, alice, team, { name: "stale-agent", host: "claude-code" });
    const withStale = usageSummary(db, alice, { team_id: team.id, group_by: "agent" });
    assert.deepEqual(withStale.agents_stale.map((r) => r.agent_id), [stale.id], "零用量的活跃 Agent 进 stale");

    // 权限：团队成员非 TA → FORBIDDEN；团队外 → NOT_FOUND；SA 可看全部团队
    expectDomain(() => usageSummary(db, bob, { team_id: team.id }), "FORBIDDEN");
    expectDomain(() => usageSummary(db, outsider, { team_id: team.id }), "NOT_FOUND");
    assert.equal(usageSummary(db, sa, { team: "demo" }).by_asset.length, 2);

    // 参数
    expectDomain(() => usageSummary(db, alice, {}), "INVALID_ARGUMENT");
    expectDomain(() => usageSummary(db, alice, { team_id: team.id, days: 0 }), "INVALID_ARGUMENT");
    expectDomain(() => usageSummary(db, alice, { team_id: team.id, days: 181 }), "INVALID_ARGUMENT");
    expectDomain(() => usageSummary(db, alice, { team_id: team.id, group_by: "title" }), "INVALID_ARGUMENT");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("audit: append-only metadata, refuses content or key material", () => {
  const dir = tempDir();
  try {
    const { db, alice } = fixture(dir);
    writeAudit(db, {
      action: "asset/update",
      request_id: "req-1",
      actor_user_id: alice.id,
      target_type: "asset",
      target_id: "ast_x",
      detail: { version: { from: 1, to: 2 }, visibility: { from: "private", to: "team" } },
    });
    const rows = db.prepare("SELECT * FROM audit ORDER BY id").all() as unknown as {
      action: string;
      request_id: string;
      actor_user_id: string;
      target_type: string;
      target_id: string;
      detail: string;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "asset/update");
    assert.equal(rows[0]!.request_id, "req-1");
    assert.deepEqual(JSON.parse(rows[0]!.detail), {
      version: { from: 1, to: 2 },
      visibility: { from: "private", to: "team" },
    });

    // 正文 / key 不得进审计：写入即报错，且不落行
    assert.throws(() => writeAudit(db, { action: "x", detail: { content: "全文" } }), /must not carry/);
    assert.throws(() => writeAudit(db, { action: "x", detail: { nested: { user_key: "ck_x" } } }), /must not carry/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n, 1);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
