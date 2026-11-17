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
import { scanAssetPii, scanPii } from "@cinlan/knowledge-core";

/**
 * PII / secrets 规则预检（deep-memory.md §3.5）：形状正则、命中警告不拦截。
 * 验证三层：core 扫描器规则面、hub 响应形态（warnings 键空时不出现）、三入口（create/共享/沉淀）。
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
  dir = mkdtempSync(join(tmpdir(), "ck-hub-pii-"));
  config.dataDir = dir;
  db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  saKey = createUserKey(db, sa.id, "sa").key;
  server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const team = await ok("team/create", { name: "cinlan", title: "Cinlan" });
  teamId = (team.team as { id: string }).id;
  const lin = await ok("user/create-with-key", { name: "lin", display_name: "Lin", key_name: "pii" });
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
  return r.env.data;
}

test("core scanner: 凭据形状命中、正文干净零命中、本机回环不报私网", () => {
  const hits = (t: string): string[] => scanPii(t).map((h) => h.kind);
  assert.deepEqual(hits("联系 sk-proj-abc123def456ghi789jkl012mno345 获取权限"), ["openai_key"]);
  assert.deepEqual(hits("用 sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 做测试"), ["anthropic_key"]);
  assert.deepEqual(hits("AKIAIOSFODNN7EXAMPLE 是旧 key"), ["aws_access_key"]);
  assert.deepEqual(hits("AIzaSyA1234567890abcdefghijklmnopqrstuv 是 google key"), ["google_api_key"]);
  assert.deepEqual(hits("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDE 是 token"), ["github_token"]);
  assert.deepEqual(hits("header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"), ["bearer_token"]);
  // 短 Bearer（占位符）不报
  assert.deepEqual(hits("Bearer your-token-here"), []);
  assert.deepEqual(hits("http://10.0.3.15:8424 是内网地址"), ["private_ip"]);
  assert.deepEqual(hits("http://127.0.0.1:8424 是本机，不报"), []);
  assert.deepEqual(hits("发到 lin@example.com 抄送 ops@example.org"), ["email"]);
  // 干净正文零命中
  assert.deepEqual(hits("发布前跑全部测试，再翻 current symlink。"), []);
  assert.deepEqual(hits("值班暗号 magpie-round-77，明早九点前有效。"), []);
  // 多条命中去重
  const multi = scanAssetPii({ title: "发 sk-proj-abc123def456ghi789jkl012mno345 给 ops@example.com", content: "另一个 sk-proj-zzz999yyy888xxx777www666vvv555" });
  assert.deepEqual(multi.map((h) => h.kind), ["email", "openai_key"]);
});

test("hub: asset/create with key-shaped content warns; clean content has no warnings key", async () => {
  const dirty = (await ok("asset/create", { team_id: teamId, type: "memory", title: "含密钥的笔记", content: "API key: sk-proj-abc123def456ghi789jkl012mno345 勿外传" }, linKey)) as {
    asset: { id: string; status: string };
    warnings?: { pii: { kind: string }[] };
  };
  assert.ok(Array.isArray(dirty.warnings?.pii), "warnings.pii should be present");
  assert.deepEqual(dirty.warnings?.pii.map((p) => p.kind), ["openai_key"]);
  assert.equal(dirty.asset.status, "active", "警告不拦截：资产照常生效");

  const clean = (await ok("asset/create", { team_id: teamId, type: "memory", title: "正常笔记", content: "发布前跑测试。" }, linKey)) as Record<string, unknown>;
  assert.equal("warnings" in clean, false, "干净内容不出现 warnings 键");
});

test("hub: set-visibility elevating dirty content warns; demotion does not scan", async () => {
  const created = (await ok("asset/create", { team_id: teamId, type: "memory", title: "内网 wiki 入口", content: "http://192.168.1.20:8080 是文档入口" }, linKey)) as { asset: { id: string } };
  const shared = (await ok("asset/set-visibility", { asset_id: created.asset.id, visibility: "team", note: "内网文档" }, linKey)) as {
    status: string;
    warnings?: { pii: { kind: string }[] };
  };
  assert.ok(Array.isArray(shared.warnings?.pii), "elevate should scan");
  assert.deepEqual(shared.warnings?.pii.map((p) => p.kind), ["private_ip"]);
  assert.equal(shared.status, "pending_review", "警告不拦截共享（走 share 团队的审批门）");
});

test("hub: session/report candidates carry per-candidate warnings", async () => {
  const out = (await ok(
    "session/report",
    {
      team_id: teamId,
      session_id: "sess-pii",
      candidates: [
        { type: "memory", title: "干净候选", content: "正常经验。" },
        { type: "memory", title: "带 token 的候选", content: "网关 key 是 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig" },
      ],
    },
    linKey,
  )) as { drafts: { title: string; warnings?: { pii: { kind: string }[] } }[] };
  assert.equal(out.drafts.length, 2);
  assert.equal("warnings" in out.drafts[0]!, false, "干净候选不出现 warnings 键");
  assert.deepEqual(out.drafts[1]!.warnings?.pii.map((p) => p.kind), ["bearer_token"]);
});

test("v2 evidence trail: same-title candidates from different sessions merge (proof_count increments)", async () => {
  // 第一次：创建草稿
  const first = (await ok(
    "session/report",
    { team_id: teamId, session_id: "sess_a", candidates: [{ type: "memory", title: "夜班暗号", content: "暗号是 alpha-1", layer: "atom" }] },
    linKey,
  )) as { drafts: { id: string; proof_count?: number }[] };
  assert.equal(first.drafts.length, 1);
  assert.equal(first.drafts[0]!.proof_count, 1, "第一次 proof_count = 1");
  const firstId = first.drafts[0]!.id;

  // 第二次（不同 session，同标题）：合并进已有草稿
  const second = (await ok(
    "session/report",
    { team_id: teamId, session_id: "sess_b", candidates: [{ type: "memory", title: "夜班暗号", content: "暗号是 alpha-1", layer: "atom" }] },
    linKey,
  )) as { drafts: { id: string; proof_count?: number; session_ids?: string[] }[] };
  assert.equal(second.drafts.length, 1);
  assert.equal(second.drafts[0]!.id, firstId, "同一草稿（不重复创建）");
  assert.equal(second.drafts[0]!.proof_count, 2, "proof_count 累加到 2");
  assert.deepEqual(second.drafts[0]!.session_ids, ["sess_a", "sess_b"], "session_ids 累积");

  // 第三次（同 session 重复报）：proof_count 加但 session_ids 不重复
  const third = (await ok(
    "session/report",
    { team_id: teamId, session_id: "sess_b", candidates: [{ type: "memory", title: "夜班暗号", content: "暗号是 alpha-1", layer: "atom" }] },
    linKey,
  )) as { drafts: { proof_count?: number; session_ids?: string[] }[] };
  assert.equal(third.drafts[0]!.proof_count, 3, "同 session 重复报也累加 proof_count");
  assert.deepEqual(third.drafts[0]!.session_ids, ["sess_a", "sess_b"], "session_ids 不重复");

  // 别人的同标题草稿不会被合并（仅限 owner 自己的）
  const saDraft = (await ok(
    "session/report",
    { team_id: teamId, session_id: "sess_sa", candidates: [{ type: "memory", title: "夜班暗号", content: "SA 的版本", layer: "atom" }] },
    saKey,
  )) as { drafts: { id: string }[] };
  assert.notEqual(saDraft.drafts[0]!.id, firstId, "不同 owner 不合并");
});
