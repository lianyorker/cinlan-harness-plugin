import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { closeDatabase, createUser, createUserKey, openDatabase, type Db } from "@cinlan/knowledge-core";
import type { Envelope } from "@cinlan/knowledge-sdk";
import { createHubServer } from "../src/server.js";
import type { HubConfig } from "../src/config.js";

/**
 * 走真实 HTTP 的 P1 主链路：B 能读 A 共享的资产、看不到私有资产、
 * 越权读取一律 NOT_FOUND、吊销 key 后立刻 401。
 */

let dir: string;
let db: Db;
let server: Server;
let base: string;
let saKey: string;

const config: HubConfig = {
  dataDir: "",
  listen: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
  limits: { maxBodyBytes: 8 * 1024 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880 },
  log: { level: "error" },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-p1-"));
  config.dataDir = dir;
  db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  saKey = createUserKey(db, sa.id, "sa").key;
  server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

interface RpcOptions {
  key?: string;
  agent?: string;
  body?: unknown;
}

async function rpc(path: string, opts: RpcOptions = {}): Promise<{ status: number; env: Envelope<Record<string, unknown>> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.authorization = `Bearer ${opts.key ?? saKey}`;
  if (opts.agent !== undefined) headers["x-ck-agent-id"] = opts.agent;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
  return { status: res.status, env: (await res.json()) as Envelope<Record<string, unknown>> };
}

function expectOk(r: { status: number; env: Envelope<Record<string, unknown>> }): Record<string, unknown> {
  assert.equal(r.status, 200, JSON.stringify(r.env));
  assert.equal(r.env.code, 0, JSON.stringify(r.env));
  return r.env.data;
}

test("P1 over HTTP: share, search, loadout, review and key revocation", async () => {
  // 两个用户：A 通过 SA 建，B 带 key 一起建
  const aOut = expectOk(await rpc("/api/v1/user/create-with-key", { body: { name: "alice", display_name: "Alice", key_name: "k" } }));
  const aKey = (aOut.key as { key: string }).key;
  const aId = (aOut.user as { id: string }).id;
  const bOut = expectOk(await rpc("/api/v1/user/create-with-key", { body: { name: "bob", display_name: "Bob", key_name: "k" } }));
  const bKey = (bOut.key as { key: string }).key;
  const bId = (bOut.user as { id: string }).id;

  // 明文 key 不回显在审计里；能直接登录
  const bVerify = expectOk(await rpc("/api/v1/auth/verify", { key: bKey }));
  assert.equal((bVerify.user as { id: string }).id, bId);

  // 团队：A 是 TA，B 是成员
  const teamOut = expectOk(await rpc("/api/v1/team/create", { body: { name: "demo", title: "Demo" } }));
  const teamId = (teamOut.team as { id: string }).id;
  expectOk(await rpc("/api/v1/team-member/add", { body: { team_id: teamId, user_id: aId, role: "admin" } }));
  expectOk(await rpc("/api/v1/team-member/add", { body: { team_id: teamId, user_id: bId, role: "member" } }));

  // A 建一条私有 memory 和一条技能
  const m1 = expectOk(
    await rpc("/api/v1/asset/create", {
      key: aKey,
      body: { team_id: teamId, type: "memory", title: "构建约定", content: "pnpm build 后再跑 test", tags: ["构建"] },
    }),
  );
  const m1Id = (m1.asset as { id: string }).id;
  const s1 = expectOk(
    await rpc("/api/v1/asset/create", {
      key: aKey,
      body: {
        team_id: teamId,
        type: "skill",
        name: "release-check",
        title: "发布检查",
        content: "---\nname: release-check\ndescription: 发布前的构建与冒烟检查\n---\n\n1. 构建\n2. 冒烟",
      },
    }),
  );
  assert.equal((s1.asset as { version: number }).version, 1);

  // 私有：B 读不到
  const invisible = await rpc("/api/v1/asset/get", { key: bKey, body: { asset_id: m1Id } });
  assert.equal(invisible.status, 404);
  assert.equal(invisible.env.message, "NOT_FOUND");

  // 共享到 team
  expectOk(await rpc("/api/v1/asset/set-visibility", { key: aKey, body: { asset_id: m1Id, visibility: "team" } }));

  // B 能读到，并按团队过滤检索到
  const got = expectOk(await rpc("/api/v1/asset/get", { key: bKey, body: { asset_id: m1Id } }));
  assert.equal((got.asset as { id: string }).id, m1Id);

  const search = expectOk(await rpc("/api/v1/asset/search", { key: bKey, body: { query: "构建", team_id: teamId } }));
  assert.ok((search.hits as { asset_id: string }[]).some((h) => h.asset_id === m1Id));

  // B 的 Agent：ensure 幂等
  const e1 = expectOk(await rpc("/api/v1/agent/ensure", { key: bKey, body: { team_id: teamId, name: "bob-cc", host: "claude-code" } }));
  const agentId = (e1.agent as { id: string }).id;
  assert.equal(e1.created, true);
  const e2 = expectOk(await rpc("/api/v1/agent/ensure", { key: bKey, body: { team_id: teamId, name: "bob-cc", host: "claude-code" } }));
  assert.equal(e2.created, false);

  // 绑定 + 解析：读档里能看到共享资产
  expectOk(await rpc("/api/v1/loadout/bind", { key: bKey, body: { agent_id: agentId, asset_id: m1Id, priority: 0 } }));
  const resolved = expectOk(await rpc("/api/v1/loadout/resolve", { key: bKey, body: { agent_id: agentId } }));
  assert.equal(typeof resolved.digest, "string");
  assert.match(resolved.text as string, /构建约定/);

  // 带 x-ck-agent-id 的 get 记一次 opened
  expectOk(await rpc("/api/v1/asset/get", { key: bKey, agent: agentId, body: { asset_id: m1Id } }));
  const opened = db
    .prepare("SELECT opened FROM usage_daily WHERE asset_id = ? AND agent_id = ?")
    .get(m1Id, agentId) as { opened: number } | undefined;
  assert.equal(opened?.opened, 1);

  // B 的 Agent 冒充别人的资产：A 用 B 的 agent id → NOT_FOUND（不属于自己）
  const foreign = await rpc("/api/v1/asset/get", { key: aKey, agent: agentId, body: { asset_id: m1Id } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.env.message, "NOT_FOUND");

  // 可读者不能提权：share 模式下本就要审批，且"提升可见性"只有管理者能做
  const escalate = await rpc("/api/v1/asset/set-visibility", {
    key: bKey,
    body: { asset_id: m1Id, visibility: "restricted", acl: [{ subject_type: "user", subject_id: aId, permission: "read" }] },
  });
  assert.equal(escalate.status, 403);
  assert.equal(escalate.env.message, "FORBIDDEN");

  // 可读者提议修改（review_mode=share → 需审批）
  const proposal = expectOk(
    await rpc("/api/v1/asset/update", { key: bKey, body: { asset_id: m1Id, base_version: 1, content: "pnpm build 后再跑 test，并更新 CHANGELOG" } }),
  );
  assert.equal(proposal.status, "pending_review");
  const reviewId = proposal.review_id as string;
  assert.equal(proposal.proposed_version, 2);

  // 待审期间 A 看不到拟议版本（仍是 v1）
  const stillV1 = expectOk(await rpc("/api/v1/asset/get", { key: aKey, body: { asset_id: m1Id } }));
  assert.equal((stillV1.version as { version: number }).version, 1);

  const listed = expectOk(await rpc("/api/v1/review/list", { key: aKey, body: { team_id: teamId, status: "pending" } }));
  assert.ok((listed.items as { id: string }[]).some((r) => r.id === reviewId));

  const detail = expectOk(await rpc("/api/v1/review/get", { key: aKey, body: { review_id: reviewId } }));
  assert.equal((detail.base as { version: number }).version, 1);
  assert.equal((detail.proposed as { version: number }).version, 2);

  // 驳回必须给理由
  const noReason = await rpc("/api/v1/review/decide", { key: aKey, body: { review_id: reviewId, decision: "reject" } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.env.message, "REASON_REQUIRED");

  const decided = expectOk(await rpc("/api/v1/review/decide", { key: aKey, body: { review_id: reviewId, decision: "approve" } }));
  assert.equal((decided.review as { status: string }).status, "approved");

  // 二次裁决 → REVIEW_NOT_PENDING
  const again = await rpc("/api/v1/review/decide", { key: aKey, body: { review_id: reviewId, decision: "approve" } });
  assert.equal(again.status, 409);
  assert.equal(again.env.message, "REVIEW_NOT_PENDING");

  // T8：吊销 B 的 key，下一次调用立刻 401
  const keys = expectOk(await rpc("/api/v1/user-key/list", { key: bKey, body: {} }));
  const keyId = (keys.keys as { id: string }[])[0]!.id;
  expectOk(await rpc("/api/v1/user-key/revoke", { key: bKey, body: { key_id: keyId } }));
  const afterRevoke = await rpc("/api/v1/auth/verify", { key: bKey });
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.env.message, "UNAUTHORIZED");

  // 审计里没有 key 明文
  const auditRows = db.prepare("SELECT action, detail FROM audit ORDER BY id").all() as unknown as { action: string; detail: string }[];
  assert.ok(auditRows.some((r) => r.action === "asset/set-visibility"));
  assert.ok(auditRows.every((r) => !r.detail.includes(bKey) && !r.detail.includes(aKey)));
});
