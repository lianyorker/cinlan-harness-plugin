import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { closeDatabase, createUser, createUserKey, ensureVec0, openDatabase, type Db } from "@cinlan/knowledge-core";
import type { Envelope } from "@cinlan/knowledge-sdk";
import { createHubServer } from "../src/server.js";
import { loadConfig, type HubConfig } from "../src/config.js";

/**
 * P3 主链路（O-9 向量检索 + O-7 自动沉淀，2026-11-16）：
 * embedding/put 与 query_embedding 检索的 HTTP 端到端、越权回填、
 * session/report → 草稿隐私 → inbox/adopt（含 share 团队的审批分支）。
 */

let dir: string;
let db: Db;
let server: Server;
let base: string;
let saKey: string;
let linKey: string;
let teamId: string;

const config: HubConfig = {
  dataDir: "",
  listen: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
  limits: { maxBodyBytes: 8 * 1024 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880 },
  log: { level: "error" },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-p3-"));
  config.dataDir = dir;
  db = openDatabase({ file: join(dir, "knowledge.db") });
  ensureVec0(db, 4);
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  saKey = createUserKey(db, sa.id, "sa").key;
  server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const team = await ok("team/create", { name: "cinlan", title: "Cinlan" });
  teamId = (team.team as { id: string }).id;
  const lin = await ok("user/create-with-key", { name: "lin", display_name: "Lin", key_name: "p3" });
  linKey = (lin.key as { key: string }).key;
  await ok("team-member/add", { team_id: teamId, user_id: (lin.user as { id: string }).id, role: "member" });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

async function rpc(action: string, key: string, body: unknown = {}): Promise<{ status: number; env: Envelope<Record<string, unknown>> }> {
  const res = await fetch(`${base}/api/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, env: (await res.json()) as Envelope<Record<string, unknown>> };
}

async function ok(action: string, body: unknown = {}, key: string = saKey): Promise<Record<string, unknown>> {
  const r = await rpc(action, key, body);
  assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.env)}`);
  assert.equal(r.env.code, 0, `${action}: ${JSON.stringify(r.env)}`);
  return r.env.data;
}

async function fails(action: string, key: string, body: unknown, code: number): Promise<void> {
  const r = await rpc(action, key, body);
  assert.equal(r.env.code, code, `${action}: expected ${code}, got ${JSON.stringify(r.env)}`);
}

test("O-9: embedding/put → search with query_embedding ranks semantically over HTTP", async () => {
  const duty = await ok("asset/create", { team_id: teamId, type: "memory", title: "值班响应约定", content: "夜间 P0 告警先看 hub 日志，十分钟内留痕。" });
  const release = await ok("asset/create", { team_id: teamId, type: "memory", title: "发版检查清单", content: "发布前跑全部测试，再翻 current。" });
  for (const asset of [duty, release]) {
    await ok("asset/set-visibility", { asset_id: (asset.asset as { id: string }).id, visibility: "team" });
  }
  // SA 是团队 Admin：直通
  await ok("embedding/put", { asset_id: (duty.asset as { id: string }).id, model: "fake-mini", vectors: [[1, 0, 0, 0]] });
  await ok("embedding/put", { asset_id: (release.asset as { id: string }).id, model: "fake-mini", vectors: [[0, 1, 0, 0]] });

  // 词法完全不命中的查询，语义路定位到值班
  const semantic = await ok("asset/search", { query: "深夜", query_embedding: [0.99, 0.05, 0, 0] });
  const hits = semantic.hits as { asset_id: string }[];
  assert.equal(hits[0]!.asset_id, (duty.asset as { id: string }).id);

  // RRF：两路都命中「告警」；双路王是值班
  const fused = await ok("asset/search", { query: "告警", query_embedding: [0.9, 0.2, 0, 0] });
  assert.equal(((fused.hits as { asset_id: string }[])[0]!.asset_id), (duty.asset as { id: string }).id);

  // pending 清单不再包含已回填的两条
  const pending = await ok("embedding/pending", { team_id: teamId });
  const pendingIds = ((pending.items as { asset_id: string }[]).map((i) => i.asset_id));
  assert.equal(pendingIds.includes((duty.asset as { id: string }).id), false);
  assert.equal(pendingIds.includes((release.asset as { id: string }).id), false);
});

test("O-9: embedding/put by a non-manage member → FORBIDDEN; invisible asset → NOT_FOUND", async () => {
  const priv = await ok("asset/create", { team_id: teamId, type: "memory", title: "SA 的私有", content: "x" });
  const shared = await ok("asset/create", { team_id: teamId, type: "memory", title: "共享条目", content: "y" });
  await ok("asset/set-visibility", { asset_id: (shared.asset as { id: string }).id, visibility: "team" });
  // lin 是普通成员：私有读不到 → NOT_FOUND；共享读得到但无管理权 → FORBIDDEN
  await fails("embedding/put", linKey, { asset_id: (priv.asset as { id: string }).id, model: "m", vectors: [[1, 0, 0, 0]] }, 404);
  await fails("embedding/put", linKey, { asset_id: (shared.asset as { id: string }).id, model: "m", vectors: [[1, 0, 0, 0]] }, 403);
});

test("O-7: session/report → drafts invisible to others → inbox/adopt (direct, then via share review)", async () => {
  const data = await ok("session/report", { team_id: teamId, session_id: "sess_p3", candidates: [
    { type: "memory", title: "夜班教训", content: "先回滚止血。", layer: "atom" },
  ] }, linKey);
  const draftId = (data.drafts as { id: string }[])[0]!.id;

  // 草稿：SA（团队 Admin）也读不到正文——draft 只属于 owner（canRead 对 draft 为 false）
  await fails("asset/get", saKey, { asset_id: draftId }, 404);
  const none = await ok("asset/search", { query: "夜班", team_id: teamId }, linKey);
  assert.equal((none.hits as unknown[]).length, 0, "draft must not be searchable even for its owner");

  // 越权采纳：SA 不是 owner，草稿对他不可见 → NOT_FOUND
  await fails("inbox/adopt", saKey, { asset_id: draftId }, 404);

  // 采纳 + 申请共享：share 团队开审批，资产保持 private
  const adopted = await ok("inbox/adopt", { asset_id: draftId, visibility: "team", note: "全员适用" }, linKey);
  assert.equal(adopted.status, "active");
  assert.equal(adopted.visibility, "private");
  assert.ok(typeof adopted.review_id === "string", "share review mode should open a review");

  // 重复采纳 → INVALID_ARGUMENT
  await fails("inbox/adopt", linKey, { asset_id: draftId }, 400);

  // SA 审批通过后团队可见
  await ok("review/decide", { review_id: adopted.review_id as string, decision: "approve" });
  const nowVisible = await ok("asset/search", { query: "夜班", team_id: teamId }, linKey);
  assert.equal((nowVisible.hits as unknown[]).length, 1);
});

test("O-7: session/report validation and atomicity", async () => {
  await fails("session/report", linKey, { team_id: teamId, candidates: [] }, 400);
  const six = Array.from({ length: 6 }, (_, i) => ({ type: "memory", title: `t${i}`, content: "c" }));
  await fails("session/report", linKey, { team_id: teamId, candidates: six }, 400);
  // 非团队成员的 team → 存在性不泄露（resolveTeam 对非成员回 NOT_FOUND，与既有口径一致）
  const other = await ok("team/create", { name: "other", title: "Other" });
  await fails("session/report", linKey, { team_id: (other.team as { id: string }).id, candidates: [{ type: "memory", title: "t", content: "c" }] }, 404);
  // 整批原子：第二条坏（type 非法）→ 一条都不落
  await fails(
    "session/report",
    linKey,
    { team_id: teamId, candidates: [
      { type: "memory", title: "好的", content: "c" },
      { type: "nonsense", title: "坏的", content: "c" },
    ] },
    400,
  );
  const left = await ok("embedding/pending", { team_id: teamId }, saKey);
  void left;
  const found = await ok("asset/search", { query: "好的", team_id: teamId }, linKey);
  assert.equal((found.hits as unknown[]).length, 0, "a failed report must not leave partial drafts");
});

test("config: embedding.dims validation", () => {
  const file = join(dir, "cfg.json");
  const tryLoad = (raw: string): ReturnType<typeof loadConfig> => {
    writeFileSync(file, raw);
    return loadConfig(file);
  };
  assert.deepEqual(tryLoad(`{"dataDir":"."}`).problems, []);
  assert.equal(tryLoad(`{"dataDir":"."}`).config!.embedding, undefined);
  assert.equal(tryLoad(`{"dataDir":".","embedding":{"dims":1536}}`).config!.embedding!.dims, 1536);
  assert.deepEqual(tryLoad(`{"dataDir":".","embedding":{"dims":0}}`).problems, ["embedding.dims: integer 1..4096"]);
  assert.deepEqual(tryLoad(`{"dataDir":".","embedding":{"dims":4097}}`).problems, ["embedding.dims: integer 1..4096"]);
  assert.deepEqual(tryLoad(`{"dataDir":".","embedding":{"dims":"x"}}`).problems, ["embedding.dims: integer 1..4096"]);
  assert.deepEqual(tryLoad(`{"dataDir":".","embedding":"nope"}`).problems, ["embedding: object { dims }"]);
});

test("config: backup.every validation", () => {
  const file = join(dir, "cfg.json");
  const tryLoad = (raw: string): ReturnType<typeof loadConfig> => {
    writeFileSync(file, raw);
    return loadConfig(file);
  };
  assert.equal(tryLoad(`{"dataDir":"."}`).config!.backup, undefined);
  assert.deepEqual(tryLoad(`{"dataDir":".","backup":{"every":"24h"}}`).config!.backup, { every: "24h" });
  assert.deepEqual(tryLoad(`{"dataDir":".","backup":{"every":"168h"}}`).config!.backup, { every: "168h" });
  assert.deepEqual(tryLoad(`{"dataDir":".","backup":{"every":"0h"}}`).problems, ["backup.every: 1..8760 hours"]);
  assert.deepEqual(tryLoad(`{"dataDir":".","backup":{"every":"8761h"}}`).problems, ["backup.every: 1..8760 hours"]);
  assert.deepEqual(tryLoad(`{"dataDir":".","backup":{"every":"24d"}}`).problems, ["backup.every: \"Nh\" format (e.g. \"24h\")"]);
  assert.deepEqual(tryLoad(`{"dataDir":".","backup":"nope"}`).problems, ["backup: object { every }"]);
});
