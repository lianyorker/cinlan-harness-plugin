import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { closeDatabase, createUser, createUserKey, ensureVec0, openDatabase, type Db } from "@cinlan/knowledge-core";
import type { Envelope } from "@cinlan/knowledge-sdk";
import { createHubServer } from "../src/server.js";
import type { HubConfig } from "../src/config.js";

/**
 * T9 契约（docs/sop.md、api.md §6）：把 sdk 里每份 fixture 的请求原样发给真实 hub，
 * 真实响应必须与 fixture 的响应逐字段一致。
 *
 * "一致"的口径：字段集合完全相同（不多不少）、每个值的类别相同。id / 时间戳 / sha256
 * 每次运行都不同，只比类别；其余标量比值——所以每个用例先把库摆成 fixture 讲的那个场景。
 * loadout/resolve 的 chars / bytes / text 取决于正文，data 只比形状。
 */

const FIXTURES = dirname(fileURLToPath(import.meta.resolve("@cinlan/knowledge-sdk/fixtures/auth-verify.json")));

interface Fixture {
  action: string;
  request: Record<string, unknown>;
  response: Envelope<unknown>;
}

const replayed = new Set<string>();

function fixture(name: string): Fixture {
  replayed.add(`${name}.json`);
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

const ID = /^(usr|team|agt|ast|rev|req)_[0-9a-f]{24}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") {
    const id = ID.exec(value);
    if (id) return `id:${id[1]}`;
    if (ISO.test(value)) return "timestamp";
    if (SHA256.test(value)) return "sha256";
    return "string";
  }
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** 逐字段比对，把所有不一致收集到 out；exact 时普通标量还要值相等、数组还要等长。 */
function diff(want: unknown, got: unknown, path: string, exact: boolean, out: string[]): void {
  const wk = kind(want);
  const gk = kind(got);
  if (wk !== gk) {
    out.push(`${path}: fixture 是 ${wk}，hub 是 ${gk}`);
    return;
  }
  if (wk === "array") {
    const w = want as unknown[];
    const g = got as unknown[];
    // 空数组是合法值（agents_stale / cold 等治理清单在干净库上就是空的）；
    // exact 模式下才验证数组形状
    if (g.length === 0 && exact) out.push(`${path}: hub 返回空数组，元素形状没验到`);
    if (exact && w.length !== g.length) out.push(`${path}: fixture ${w.length} 项，hub ${g.length} 项`);
    g.forEach((item, i) => diff(w[exact ? Math.min(i, w.length - 1) : 0], item, `${path}[${i}]`, exact, out));
    return;
  }
  if (wk === "object") {
    const w = want as Record<string, unknown>;
    const g = got as Record<string, unknown>;
    for (const key of Object.keys(w)) {
      if (!(key in g)) out.push(`${path}.${key}: fixture 有，hub 没有`);
      else diff(w[key], g[key], `${path}.${key}`, exact, out);
    }
    for (const key of Object.keys(g)) {
      if (!(key in w)) out.push(`${path}.${key}: hub 有，fixture 没有`);
    }
    return;
  }
  if (exact && (wk === "string" || wk === "integer" || wk === "number" || wk === "boolean") && want !== got) {
    out.push(`${path}: fixture 是 ${JSON.stringify(want)}，hub 是 ${JSON.stringify(got)}`);
  }
}

let dir: string;
let db: Db;
let server: Server;
let base: string;
let yorkerKey: string;
let linKey: string;

/** fixture 里的占位 id → 本次运行里扮演同一角色的真实 id */
const real = new Map<string, string>();

const config: HubConfig = {
  dataDir: "",
  listen: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
  limits: { maxBodyBytes: 8 * 1024 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880 },
  log: { level: "error" },
};

interface Reply {
  status: number;
  env: Envelope<Record<string, unknown>>;
}

async function rpc(action: string, key: string, body: unknown = {}): Promise<Reply> {
  const res = await fetch(`${base}/api/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, env: (await res.json()) as Envelope<Record<string, unknown>> };
}

async function ok(action: string, key: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const r = await rpc(action, key, body);
  assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.env)}`);
  return r.env.data;
}

function remap(value: unknown): unknown {
  if (typeof value === "string") {
    if (!ID.test(value)) return value;
    const id = real.get(value);
    assert.ok(id !== undefined, `fixture 里的 ${value} 在场景里没有对应的真实 id`);
    return id;
  }
  if (Array.isArray(value)) return value.map(remap);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
  }
  return value;
}

/** 发 fixture 的请求（占位 id 换成真实 id），比对真实响应；返回真实 data。 */
async function replay(name: string, key: string, exact = true): Promise<Record<string, unknown>> {
  const fx = fixture(name);
  const r = await rpc(fx.action, key, remap(fx.request));
  // HTTP 状态码 = 信封 code（成功是 200 / 0）
  assert.equal(r.status, fx.response.code === 0 ? 200 : fx.response.code, `${name}: ${JSON.stringify(r.env)}`);
  const { data: wantData, ...wantHead } = fx.response;
  const { data: gotData, ...gotHead } = r.env;
  const problems: string[] = [];
  diff(wantHead, gotHead, "response", true, problems);
  diff(wantData, gotData, "response.data", exact, problems);
  assert.deepEqual(problems, [], `${name}: hub 的真实响应与 fixture 不一致`);
  return r.env.data;
}

async function memory(key: string, title: string, content: string): Promise<string> {
  const out = await ok("asset/create", key, { team_id: real.get(TEAM), type: "memory", title, content });
  return (out.asset as { id: string }).id;
}

const USER = "usr_111111111111111111111111";
const TEAM = "team_222222222222222222222222";
const AGENT = "agt_333333333333333333333333";
const ASSET = "ast_444444444444444444444444";
const REVIEW = "rev_999999999999999999999999";
const DRAFT = "ast_555555555555555555555555";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-contract-"));
  config.dataDir = dir;
  db = openDatabase({ file: join(dir, "knowledge.db") });
  // P3 fixture（embedding-put）需要 vec0 索引：真实 hub 的 serve 会按 config 建表，这里对齐
  ensureVec0(db, 4);
  // fixture 的主角：SA yorker，建团队 cinlan 后即为该团队 Admin
  const yorker = createUser(db, { name: "yorker", display_name: "Yorker", is_system_admin: true });
  yorkerKey = createUserKey(db, yorker.id, "contract").key;
  real.set(USER, yorker.id);
  server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const team = await ok("team/create", yorkerKey, { name: "cinlan", title: "Cinlan" });
  real.set(TEAM, (team.team as { id: string }).id);
  const lin = await ok("user/create-with-key", yorkerKey, { name: "lin", display_name: "Lin", key_name: "contract" });
  linKey = (lin.key as { key: string }).key;
  await ok("team-member/add", yorkerKey, { team_id: real.get(TEAM), user_id: (lin.user as { id: string }).id, role: "member" });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

test("T9 auth/verify", async () => {
  await replay("auth-verify", yorkerKey);
});

test("T9 asset/create", async () => {
  const data = await replay("asset-create", yorkerKey);
  real.set(ASSET, (data.asset as { id: string }).id);
});

test("T9 asset/update → 409 VERSION_CONFLICT", async () => {
  // fixture：资产已到 v4，调用方还拿着 v2
  for (const base_version of [1, 2, 3]) {
    const out = await ok("asset/update", yorkerKey, { asset_id: real.get(ASSET), base_version, content: `发布前先跑 e2e（第 ${base_version + 1} 版）` });
    assert.deepEqual(out, { changed: true, version: base_version + 1 });
  }
  await replay("error-version-conflict", yorkerKey);
});

test("T9 agent/ensure", async () => {
  // fixture：团队默认模板上有 4 条绑定，新建 Agent 时整份拷过来
  const template = await ok("agent/create", yorkerKey, { team_id: real.get(TEAM), name: "template", host: "claude-code", is_template: true });
  const templateId = (template.agent as { id: string }).id;
  const skill = await ok("asset/create", yorkerKey, {
    team_id: real.get(TEAM),
    type: "skill",
    name: "deploy-release",
    title: "发版",
    content: "---\nname: deploy-release\ndescription: 发版流程\n---\n\n1. 构建\n2. 冒烟",
  });
  // lin 的一条经审批共享到团队的记忆：之后收回成 private，配装里就多出一条 no_access
  const shared = await memory(linKey, "临时约定", "周五不发版");
  const asked = await ok("asset/set-visibility", linKey, { asset_id: shared, visibility: "team" });
  assert.equal(asked.status, "pending_review");
  await ok("review/decide", yorkerKey, { review_id: asked.review_id, decision: "approve" });
  real.set("lin-shared", shared);

  const bound = [real.get(ASSET), (skill.asset as { id: string }).id, shared, await memory(yorkerKey, "回滚步骤", "先切流量再回滚")];
  for (const [i, asset_id] of bound.entries()) {
    await ok("loadout/bind", yorkerKey, { agent_id: templateId, asset_id, priority: (i + 1) * 10 });
  }
  await ok("agent/set-default-template", yorkerKey, { team_id: real.get(TEAM), agent_id: templateId });

  const data = await replay("agent-ensure", yorkerKey);
  real.set(AGENT, (data.agent as { id: string }).id);
});

test("T9 loadout/resolve", async () => {
  await ok("asset/set-visibility", linKey, { asset_id: real.get("lin-shared"), visibility: "private" });
  const data = await replay("loadout-resolve", yorkerKey, false);
  // 形状之外：fixture 里出现的枚举值，真实响应里也必须是同一套
  assert.equal(data.not_modified, false);
  assert.ok((data.items as { mode: string }[]).every((i) => i.mode === "inject" || i.mode === "tool"));
  assert.deepEqual(data.skills, [
    { asset_id: (data.skills as { asset_id: string }[])[0]!.asset_id, name: "deploy-release", version: 1, content_hash: (data.skills as { content_hash: string }[])[0]!.content_hash },
  ]);
  assert.deepEqual(data.skipped, [{ asset_id: real.get("lin-shared"), reason: "no_access" }]);
  assert.equal(data.bytes, Buffer.byteLength(data.text as string));
});

test("T9 loadout/sync-template", async () => {
  // fixture：模板在 Agent 建好之后又加了一条绑定，add-missing 只把这一条补到已有 Agent 上
  const tmpl = await ok("agent/get-default-template", yorkerKey, { team_id: real.get(TEAM) });
  const templateId = (tmpl.agent as { id: string }).id;
  const added = await memory(yorkerKey, "值班约定", "故障先拉群再排查");
  await ok("loadout/bind", yorkerKey, { agent_id: templateId, asset_id: added, priority: 50 });

  const data = await replay("loadout-sync-template", yorkerKey, false);
  assert.equal(data.applied, 1);
  assert.equal(data.removed, 0);
  assert.equal(data.template_agent_id, templateId);
  const bindings = data.bindings as { asset_id: string; source: string }[];
  assert.equal(bindings.length, 5);
  assert.equal(bindings.find((b) => b.asset_id === added)?.source, "template");

  // 显式动作留审计：目标是被下发的 Agent，detail 只有元数据
  const audit = await ok("audit/list", yorkerKey, { team_id: real.get(TEAM), action: "loadout/sync-template" });
  const rows = audit.items as { target_type: string; target_id: string; detail: Record<string, unknown> }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target_type, "agent");
  assert.equal(rows[0]!.target_id, real.get(AGENT));
  assert.deepEqual(rows[0]!.detail, { mode: "add-missing", applied: 1, removed: 0, template_agent_id: templateId });
});

test("T9 usage/summary", async () => {
  // fixture：本团队 90 天窗口里只有一条资产被用过（12 次 injected、3 次 opened）；
  // 三组都不为空 —— by_asset / by_agent 各一行，cold 至少一排零用量资产。
  const agentId = real.get(AGENT)!;
  const events = [
    ...Array.from({ length: 12 }, () => ({ asset_id: real.get(ASSET), version: 4, kind: "injected" })),
    ...Array.from({ length: 3 }, () => ({ asset_id: real.get(ASSET), version: 4, kind: "opened" })),
  ];
  await ok("usage/report", yorkerKey, { agent_id: agentId, events });
  await replay("usage-summary", yorkerKey, false);
});

test("T9 audit/list", async () => {
  // fixture：TA 限定团队与目标类型后按时间倒序翻页；资产类目标的上限由前面的建资产动作决定
  await replay("audit-list", yorkerKey, false);
});

test("T9 review/decide", async () => {
  // fixture：成员带着说明申请共享，Admin 带理由驳回
  const fx = fixture("review-decide");
  const want = (fx.response.data as { review: { note: string } }).review;
  const asset_id = await memory(linKey, "客户发版流程", "含客户名的发版流程");
  const asked = await ok("asset/set-visibility", linKey, { asset_id, visibility: "team", note: want.note });
  assert.equal(asked.status, "pending_review");
  real.set(REVIEW, asked.review_id as string);
  await replay("review-decide", yorkerKey);
});

test("T9 system/stats", async () => {
  // fixture：SA 看全库库存。数字随场景走，这里比形状，再核对几项能从场景直接数出来的
  const data = await replay("system-stats", yorkerKey, false);
  assert.deepEqual(data.users, { total: 2, active: 2, disabled: 0 });
  assert.equal(data.teams, 1);
  assert.deepEqual(data.agents, { total: 2, active: 2, archived: 0, templates: 1 });
  const assets = data.assets as { total: number; by_type: Record<string, number> };
  assert.equal(assets.by_type.skill, 1);
  assert.equal(assets.total, assets.by_type.memory! + 1);
  assert.deepEqual(data.reviews, { total: 2, pending: 0 });

  // 仅 SA：团队成员 → 403
  assert.equal((await rpc("system/stats", linKey)).status, 403);
});

test("T9 system/integrity（T7：全库复算 0 条不一致）", async () => {
  // T7：前面的用例已经把库写成多版本、带 skill、过了审批的样子，整库复算必须全绿
  const clean = await ok("system/integrity", yorkerKey);
  assert.equal(clean.ok, true);
  assert.equal(clean.issue_count, 0);
  assert.deepEqual(clean.issues, []);
  const versions = clean.versions as { total: number; verified: number; unverifiable: number; mismatched: number };
  assert.equal(versions.mismatched, 0);
  // 场景里没人改过标签，所以每个版本都复算得出，没有"无法判定"的行
  assert.equal(versions.unverifiable, 0);
  assert.equal(versions.verified, versions.total);
  assert.ok(versions.total >= 9, `versions.total = ${versions.total}`);

  // fixture：一条资产现行版本的 content_hash 被改坏 → 恰好报这一条
  const id = real.get(ASSET)!;
  const good = (db.prepare("SELECT content_hash AS h FROM asset_version WHERE asset_id = ? AND version = 4").get(id) as { h: string }).h;
  db.prepare("UPDATE asset_version SET content_hash = ? WHERE asset_id = ? AND version = 4").run("0".repeat(64), id);
  try {
    const data = await replay("system-integrity", yorkerKey, false);
    assert.equal(data.ok, false);
    assert.deepEqual(data.issues, [
      { kind: "hash_mismatch", asset_id: id, version: 4, path: null, detail: "content_hash differs from the recomputed value" },
    ]);
  } finally {
    db.prepare("UPDATE asset_version SET content_hash = ? WHERE asset_id = ? AND version = 4").run(good, id);
  }
  assert.equal((await ok("system/integrity", yorkerKey)).ok, true);

  assert.equal((await rpc("system/integrity", linKey)).status, 403);
});

test("T9 system/backup", async () => {
  // fixture：SA 触发一次备份，副本落在 hub 的 <dataDir>/backups/，落点不由调用方决定
  const data = await replay("system-backup", yorkerKey, false);
  const backup = data.backup as { file: string; path: string; bytes: number };
  assert.match(backup.file, /^knowledge-\d{8}T\d{6}Z\.db$/);
  assert.equal(backup.path, join(dir, "backups", backup.file));
  assert.equal(statSync(backup.path).size, backup.bytes);

  // 留审计：没有目标的系统动作，detail 只有文件名与大小
  const audit = await ok("audit/list", yorkerKey, { action: "system/backup" });
  const rows = audit.items as { target_type: string | null; target_id: string | null; detail: Record<string, unknown> }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target_type, null);
  assert.equal(rows[0]!.target_id, null);
  assert.deepEqual(rows[0]!.detail, { name: backup.file, size: backup.bytes });

  // 仅 SA：成员 → 403，目录里也不多文件
  assert.equal((await rpc("system/backup", linKey)).status, 403);
  assert.deepEqual(readdirSync(join(dir, "backups")), [backup.file]);
});

// 排在 system/stats 之后：那边按场景数过 skill 的条数
test("T9 asset/import", async () => {
  // fixture：成员把本机的一个 skill 导进来，落成自己的 private 资产
  const req = remap(fixture("asset-import").request) as Record<string, unknown>;
  const data = await replay("asset-import", linKey);
  const first = data.asset as { id: string; version: number; content_hash: string };
  const got = await ok("asset/get", linKey, { asset_id: first.id });
  assert.deepEqual((got.asset as { source: unknown }).source, {
    origin: "import",
    host: req.host,
    import_path: req.import_path,
  });

  // 幂等在 hub：同一份 → unchanged；内容不同 → conflict，带没被动过的那条；new_version → 出 v2
  assert.deepEqual(await ok("asset/import", linKey, req), { status: "unchanged", asset: data.asset });
  const edited = { ...req, content: `${req.content as string}3. 写变更说明\n` };
  assert.deepEqual(await ok("asset/import", linKey, edited), { status: "conflict", asset: data.asset });
  const updated = await ok("asset/import", linKey, { ...edited, on_conflict: "new_version" });
  const next = updated.asset as { id: string; version: number; content_hash: string };
  assert.equal(updated.status, "updated");
  assert.equal(next.id, first.id);
  assert.equal(next.version, 2);
  assert.notEqual(next.content_hash, first.content_hash);

  // 入参不对 → 400，不落库
  assert.equal((await rpc("asset/import", linKey, { ...req, on_conflict: "overwrite" })).status, 400);
  assert.equal((await rpc("asset/import", linKey, { ...req, host: undefined })).status, 400);

  // 四次调用各留一条审计；detail 只有结果、宿主与版本号，不带正文与本机路径
  const audit = await ok("audit/list", yorkerKey, { action: "asset/import" });
  const rows = audit.items as { target_type: string; target_id: string; detail: Record<string, unknown> }[];
  assert.deepEqual(
    rows.map((r) => [r.target_type, r.target_id]),
    Array.from({ length: 4 }, () => ["asset", first.id]),
  );
  assert.deepEqual(
    rows.map((r) => r.detail).sort((a, b) => String(a.status).localeCompare(String(b.status))),
    [
      { status: "conflict", host: "claude-code", version: 1 },
      { status: "created", host: "claude-code", version: 1 },
      { status: "unchanged", host: "claude-code", version: 1 },
      { status: "updated", host: "claude-code", version: 2 },
    ],
  );
  assert.equal((await ok("system/integrity", yorkerKey)).ok, true);
});

test("T9 任意动作 → 429 RATE_LIMITED", async () => {
  // fixture：这把 key 在 60 秒的窗口里已经用完额度。另起一个额度只有 1 的 hub 来摆这个场景
  const tight = createHubServer({
    db,
    config: { ...config, limits: { ...config.limits, rateLimit: { windowSeconds: 60, maxRequests: 1 } } },
  });
  await new Promise<void>((res) => tight.listen(0, "127.0.0.1", res));
  const usual = base;
  base = `http://127.0.0.1:${(tight.address() as AddressInfo).port}`;
  try {
    await ok("auth/verify", linKey);
    await replay("error-rate-limited", linKey);
  } finally {
    base = usual;
    await new Promise<void>((res) => tight.close(() => res()));
  }
});

test("T9 asset/rollback", async () => {
  // 场景：yorker 的私有资产——v1 建好，update 到 v2（内容变了），然后 rollback 到 v1
  const created = await memory(yorkerKey, "回滚验证目标", "第一版内容。");
  real.set(ASSET, created);
  // 先 update 到 v2（SA 直通）
  await ok("asset/update", yorkerKey, { asset_id: created, base_version: 1, content: "第二版内容。" });
  // rollback 回 v1
  const out = await replay("asset-rollback", yorkerKey);
  assert.equal((out as { status: string }).status, "applied");
  assert.equal((out as { asset: { version: number } }).asset.version, 3, "回滚产生新版本 v3");
});

test("T9 embedding/put", async () => {
  // 场景：yorker 的私有资产一条（ASSET 占位符重指到这条，避免与早前用例的资产纠缠）
  const id = await memory(yorkerKey, "向量回填目标", "正文。");
  real.set(ASSET, id);
  await replay("embedding-put", yorkerKey);
});

test("T9 embedding/pending", async () => {
  // 场景：团队里至少留一条没有向量的资产（上面这条刚回填过，早前的 memory 都没有）
  await memory(yorkerKey, "回填差集里的资产", "正文。");
  await replay("embedding-pending", yorkerKey, false);
});

test("T9 session/report → inbox/adopt", async () => {
  // 场景：yorker 的会话抽取出一条候选 → 直落私有草稿；随后原样采纳（不带可见性 → 直通）
  const data = await replay("session-report", yorkerKey);
  const draftId = (data.drafts as { id: string }[])[0]!.id;
  real.set(DRAFT, draftId);
  const adopted = await replay("inbox-adopt", yorkerKey);
  assert.equal((adopted.status as string), "active");
});

test("T9 每份 fixture 都被重放过", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual([...replayed].sort(), files);
});
