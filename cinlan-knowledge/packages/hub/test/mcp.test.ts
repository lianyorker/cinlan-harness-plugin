import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { closeDatabase, createUser, createUserKey, openDatabase, type Db } from "@cinlan/knowledge-core";
import type { Envelope } from "@cinlan/knowledge-sdk";
import { createHubServer, SERVER_VERSION } from "../src/server.js";
import type { HubConfig } from "../src/config.js";

/**
 * `/mcp` 挂载（api.md §1、§5）：走真实 HTTP，用裸 JSON-RPC 发 2025 时代的无状态请求。
 * 官方 client 的契约对照（T10）在 packages/mcp 的测试里。
 */

const PROTOCOL = "2025-06-18";
const ALLOWED_ORIGIN = "http://panel.test";

let dir: string;
let db: Db;
let server: Server;
let base: string;
let saKey: string;
let aKey: string;
let bKey: string;
let cKey: string;
let teamId: string;
let sharedId: string;
let privateId: string;

const config: HubConfig = {
  dataDir: "",
  listen: { host: "127.0.0.1", port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
  limits: { maxBodyBytes: 64 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880 },
  log: { level: "error" },
};

async function api(path: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const env = (await res.json()) as Envelope<Record<string, unknown>>;
  assert.equal(env.code, 0, `${path}: ${JSON.stringify(env)}`);
  return env.data;
}

interface McpOptions {
  key?: string | null;
  headers?: Record<string, string>;
}

let nextId = 1;

function post(message: unknown, opts: McpOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...opts.headers,
  };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? bKey}`;
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
}

interface RpcReply {
  res: Response;
  result: Record<string, unknown>;
}

/** 一次 JSON-RPC 请求；断言 MCP 面只回 JSON、不带会话头。 */
async function rpc(method: string, params: Record<string, unknown>, opts: McpOptions = {}): Promise<RpcReply> {
  const id = nextId++;
  const headers = method === "initialize" ? opts.headers : { "mcp-protocol-version": PROTOCOL, ...opts.headers };
  const res = await post({ jsonrpc: "2.0", id, method, params }, { ...opts, headers });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("mcp-session-id"), null);
  const msg = JSON.parse(raw) as { id: number; result?: Record<string, unknown>; error?: unknown };
  assert.equal(msg.id, id);
  assert.ok(msg.result !== undefined, raw);
  return { res, result: msg.result };
}

function initialize(opts: McpOptions = {}, clientName = "claude-code"): Promise<RpcReply> {
  return rpc(
    "initialize",
    { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
    opts,
  );
}

interface ToolReply {
  isError: boolean;
  text: string;
}

async function tool(name: string, args: Record<string, unknown>, opts: McpOptions = {}): Promise<ToolReply> {
  const { result } = await rpc("tools/call", { name, arguments: args }, opts);
  const content = result["content"] as { type: string; text: string }[];
  assert.equal(content.length, 1);
  return { isError: result["isError"] === true, text: content[0]?.text ?? "" };
}

async function denied(res: Response, status: number, message: string): Promise<Envelope<Record<string, unknown>>> {
  const env = (await res.json()) as Envelope<Record<string, unknown>>;
  assert.equal(res.status, status, JSON.stringify(env));
  assert.equal(env.message, message);
  return env;
}

function agentRow(name: string): { id: string; host: string } | undefined {
  return db.prepare("SELECT id, host FROM agent WHERE name = ?").get(name) as { id: string; host: string } | undefined;
}

function auditCount(action: string, target_id: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = ? AND target_id = ?").get(action, target_id) as { n: number };
  return row.n;
}

function usage(asset_id: string, agent_id: string): { injected: number; opened: number } {
  const row = db.prepare("SELECT injected, opened FROM usage_daily WHERE asset_id = ? AND agent_id = ?").get(asset_id, agent_id) as
    | { injected: number; opened: number }
    | undefined;
  return row ? { injected: row.injected, opened: row.opened } : { injected: 0, opened: 0 };
}

const BOB = { "x-ck-agent": "demo/bob-cc" };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-mcp-"));
  config.dataDir = dir;
  db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  saKey = createUserKey(db, sa.id, "sa").key;
  server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // alice = TA，bob = 成员，carol 不在团队里
  const a = await api("user/create-with-key", saKey, { name: "alice", display_name: "Alice", key_name: "k" });
  aKey = (a["key"] as { key: string }).key;
  const b = await api("user/create-with-key", saKey, { name: "bob", display_name: "Bob", key_name: "k" });
  bKey = (b["key"] as { key: string }).key;
  const c = await api("user/create-with-key", saKey, { name: "carol", display_name: "Carol", key_name: "k" });
  cKey = (c["key"] as { key: string }).key;
  const team = await api("team/create", saKey, { name: "demo", title: "Demo" });
  teamId = (team["team"] as { id: string }).id;
  await api("team-member/add", saKey, { team_id: teamId, user_id: (a["user"] as { id: string }).id, role: "admin" });
  await api("team-member/add", saKey, { team_id: teamId, user_id: (b["user"] as { id: string }).id, role: "member" });

  // 一条共享给团队的记忆 + 一条 alice 的私有记忆
  const shared = await api("asset/create", aKey, {
    team_id: teamId,
    type: "memory",
    title: "构建约定",
    content: "pnpm build 后再跑 test",
    tags: ["构建"],
  });
  sharedId = (shared["asset"] as { id: string }).id;
  await api("asset/set-visibility", aKey, { asset_id: sharedId, visibility: "team" });
  const priv = await api("asset/create", aKey, { team_id: teamId, type: "memory", title: "私人备忘", content: "只有 alice 能看" });
  privateId = (priv["asset"] as { id: string }).id;

  // 团队默认模板：绑定共享记忆，新 Agent ensure 时拷贝
  const tmpl = await api("agent/create", aKey, { team_id: teamId, name: "tmpl", host: "panel", is_template: true });
  const tmplId = (tmpl["agent"] as { id: string }).id;
  await api("loadout/bind", aKey, { agent_id: tmplId, asset_id: sharedId, priority: 0 });
  await api("agent/set-default-template", aKey, { team_id: teamId, agent_id: tmplId });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

test("/mcp transport gate: method, origin, auth, body and header errors use the envelope", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${bKey}` } });
    await denied(res, 405, "METHOD_NOT_ALLOWED");
  }

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } } };

  // 没有 key：401，且不发 WWW-Authenticate（不引客户端去走 OAuth 发现）
  const noKey = await post(init, { key: null });
  assert.equal(noKey.headers.get("www-authenticate"), null);
  await denied(noKey, 401, "UNAUTHORIZED");
  await denied(await post(init, { key: "ck_not-a-real-key" }), 401, "UNAUTHORIZED");

  await denied(await post(init, { headers: { origin: "http://evil.test" } }), 403, "FORBIDDEN");
  await denied(await post("{not json"), 400, "INVALID_ARGUMENT");
  await denied(await post(init, { headers: { "x-ck-baseline": "tiny" } }), 400, "INVALID_ARGUMENT");
  await denied(await post(init, { headers: { "x-ck-agent": "demo" } }), 400, "INVALID_ARGUMENT");
  await denied(await post(init, { headers: { "x-ck-agent": "Demo/Bob CC" } }), 400, "INVALID_ARGUMENT");

  const big = { ...init, params: { ...init.params, pad: "x".repeat(config.limits.maxBodyBytes) } };
  await denied(await post(big), 413, "PAYLOAD_TOO_LARGE");

  // 团队不存在、不是成员、别人的 agent id：都是 NOT_FOUND，不确认存在
  await denied(await post(init, { headers: { "x-ck-agent": "nope/bob-cc" } }), 404, "NOT_FOUND");
  await denied(await post(init, { key: cKey, headers: { "x-ck-agent": "demo/carol-cc" } }), 404, "NOT_FOUND");
  await denied(await post(init, { headers: { "x-ck-agent-id": "agt_missing" } }), 404, "NOT_FOUND");
  assert.equal(agentRow("carol-cc"), undefined);
});

test("/mcp initialize with x-ck-agent: ensures the agent, returns the full loadout and records injected", async () => {
  assert.equal(agentRow("bob-cc"), undefined);

  const { result } = await initialize({ headers: BOB });
  assert.deepEqual(result["serverInfo"], { name: "ck", version: SERVER_VERSION });
  const instructions = result["instructions"] as string;
  assert.match(instructions, /<cinlan_knowledge /);
  assert.match(instructions, /构建约定/);
  assert.ok(instructions.length <= 12000);

  // 取或建：首次建出 Agent 并拷贝模板配装；host 缺省取 clientInfo.name
  const agent = agentRow("bob-cc");
  assert.ok(agent);
  assert.equal(agent.host, "claude-code");
  const bound = db.prepare("SELECT source FROM agent_asset WHERE agent_id = ? AND asset_id = ?").get(agent.id, sharedId) as
    | { source: string }
    | undefined;
  assert.equal(bound?.source, "template");

  // 新建进审计（与 /api/v1 的 agent/ensure 同一条路径）；A0 的 injected 由 hub 记
  assert.equal(auditCount("agent/ensure", agent.id), 1);
  assert.deepEqual(usage(sharedId, agent.id), { injected: 1, opened: 0 });
});

test("/mcp is stateless: later requests resolve the same agent without re-auditing or clobbering host", async () => {
  const agent = agentRow("bob-cc");
  assert.ok(agent);

  // 握手之后的请求既没有 x-ck-host 也没有 clientInfo
  const { result } = await rpc("tools/list", {}, { headers: BOB });
  const names = (result["tools"] as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(names, ["knowledge_open", "knowledge_save", "knowledge_search", "knowledge_session_report", "knowledge_share", "knowledge_status"]);

  assert.equal(agentRow("bob-cc")?.host, "claude-code");
  assert.equal(auditCount("agent/ensure", agent.id), 1);
  // 非握手请求不读档、不记 injected
  assert.equal(usage(sharedId, agent.id).injected, 1);

  // x-ck-host 给了就覆盖为最新值；x-ck-agent-id 指向同一个 Agent 也可以
  await rpc("tools/list", {}, { headers: { ...BOB, "x-ck-host": "dsh" } });
  assert.equal(agentRow("bob-cc")?.host, "dsh");
  await rpc("tools/list", {}, { headers: { "x-ck-agent-id": agent.id } });
  await rpc("tools/list", {}, { headers: { ...BOB, "x-ck-agent-id": agent.id } });
  assert.equal(agentRow("bob-cc")?.host, "dsh");

  // 两个头指向不同 Agent：拒绝，不替调用方猜
  const init = { jsonrpc: "2.0", id: 1, method: "ping" };
  await denied(await post(init, { headers: { ...BOB, "x-ck-agent-id": "agt_other" } }), 400, "INVALID_ARGUMENT");
});

test("/mcp initialize: brief baseline and agent-less identity get the fixed brief", async () => {
  const agent = agentRow("bob-cc");
  assert.ok(agent);

  const brief = await initialize({ headers: { ...BOB, "x-ck-baseline": "brief" } });
  const text = brief.result["instructions"] as string;
  assert.match(text, /^<cinlan_knowledge_brief team="demo" agent="bob-cc">/);
  assert.ok(text.length <= 1500);
  assert.doesNotMatch(text, /构建约定/);
  // brief 不含资产，不记 injected
  assert.equal(usage(sharedId, agent.id).injected, 1);

  const bare = await initialize();
  assert.match(bare.result["instructions"] as string, /^<cinlan_knowledge_brief>/);
});

test("/mcp tools run through the action registry: permissions, usage, audit and error enum", async () => {
  const agent = agentRow("bob-cc");
  assert.ok(agent);

  const search = await tool("knowledge_search", { query: "构建" }, { headers: BOB });
  assert.equal(search.isError, false, search.text);
  const hits = (JSON.parse(search.text) as { hits: { id: string }[] }).hits;
  assert.ok(hits.some((h) => h.id === sharedId));
  assert.ok(!hits.some((h) => h.id === privateId));

  // 打开共享资产：带 Agent 身份，记一次 opened
  const open = await tool("knowledge_open", { id: sharedId }, { headers: BOB });
  assert.equal(open.isError, false, open.text);
  assert.equal((JSON.parse(open.text) as { content: string }).content, "pnpm build 后再跑 test");
  assert.equal(usage(sharedId, agent.id).opened, 1);

  // 别人的私有资产：错误枚举前缀，不是 HTTP 状态
  const hidden = await tool("knowledge_open", { id: privateId }, { headers: BOB });
  assert.equal(hidden.isError, true);
  assert.match(hidden.text, /^NOT_FOUND: /);

  // 保存：落到 asset/create，审计里带 Agent
  const saved = await tool("knowledge_save", { title: "bob 的结论", content: "第一版" }, { headers: BOB });
  assert.equal(saved.isError, false, saved.text);
  const savedOut = JSON.parse(saved.text) as { id: string; version: number; visibility: string };
  assert.equal(savedOut.version, 1);
  assert.equal(savedOut.visibility, "private");
  const audit = db.prepare("SELECT actor_agent_id FROM audit WHERE action = 'asset/create' AND target_id = ?").get(savedOut.id) as
    | { actor_agent_id: string | null }
    | undefined;
  assert.equal(audit?.actor_agent_id, agent.id);

  // 版本冲突：枚举开头，并把 current_version 交还调用方
  const ok = await tool("knowledge_save", { id: savedOut.id, base_version: 1, title: "bob 的结论", content: "第二版" }, { headers: BOB });
  assert.equal(ok.isError, false, ok.text);
  const stale = await tool("knowledge_save", { id: savedOut.id, base_version: 1, title: "bob 的结论", content: "第三版" }, { headers: BOB });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /^VERSION_CONFLICT: /);
  assert.match(stale.text, /"current_version":2/);

  // 自检永远可调
  const status = await tool("knowledge_status", {}, { headers: BOB });
  assert.equal(status.isError, false, status.text);
  const st = JSON.parse(status.text) as { hub: { ok: boolean; server_version: string }; agent: { id: string } | null; user: { name: string } | null };
  assert.deepEqual(st.hub, { ok: true, server_version: SERVER_VERSION });
  assert.equal(st.user?.name, "bob");
  assert.equal(st.agent?.id, agent.id);
});

test("/mcp rejects an archived agent addressed by name", async () => {
  const agent = agentRow("bob-cc");
  assert.ok(agent);
  await api("agent/archive", bKey, { agent_id: agent.id });
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  await denied(await post(ping, { headers: BOB }), 404, "NOT_FOUND");
  await denied(await post(ping, { headers: { "x-ck-agent-id": agent.id } }), 404, "NOT_FOUND");
});
