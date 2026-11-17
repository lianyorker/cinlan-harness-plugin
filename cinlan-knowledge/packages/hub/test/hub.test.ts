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

let dir: string;
let db: Db;
let server: Server;
let base: string;
let key: string;
let badKey: string;

const config: HubConfig = {
  dataDir: "",
  listen: { host: "127.0.0.1", port: 0, allowedOrigins: ["http://localhost:5173"] },
  limits: { maxBodyBytes: 1024 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880 },
  log: { level: "error" },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-"));
  config.dataDir = dir;
  db = openDatabase({ file: join(dir, "knowledge.db") });
  const user = createUser(db, { name: "yorker", display_name: "Yorker", is_system_admin: true });
  key = createUserKey(db, user.id, "test").key;
  badKey = "ck_" + key.slice(3, 11) + "_" + "1".repeat(32);
  server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

type TestEnvelope = Envelope<Record<string, unknown>>;

async function rpc(path: string, opts: { key?: string | null; method?: string; body?: unknown; origin?: string } = {}): Promise<{ status: number; env: TestEnvelope }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? key}`;
  if (opts.origin) headers.origin = opts.origin;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "GET" || opts.body === undefined ? undefined : JSON.stringify(opts.body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, env: JSON.parse(text) as TestEnvelope };
}

test("GET /healthz returns {ok:true} only", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET / redirects to /panel/", async () => {
  const res = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/panel/");
});

test("auth/verify returns user, admin flag, teams and server_version", async () => {
  const { status, env } = await rpc("/api/v1/auth/verify", { body: {} });
  assert.equal(status, 200);
  assert.equal(env.code, 0);
  assert.equal(env.message, "OK");
  assert.equal(env.data.is_system_admin, true);
  assert.equal((env.data.user as { name: string }).name, "yorker");
  assert.deepEqual(env.data.teams, []);
  assert.equal(typeof env.data.server_version, "string");
  assert.match(env.request_id, /^req_[0-9a-f]{24}$/);
});

test("x-request-id is echoed", async () => {
  const res = await fetch(`${base}/api/v1/auth/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-request-id": "req_test123" },
    body: "{}",
  });
  assert.equal(((await res.json()) as Envelope).request_id, "req_test123");
});

test("missing / wrong key → 401 UNAUTHORIZED without OAuth metadata", async () => {
  for (const k of [null, badKey]) {
    const { status, env } = await rpc("/api/v1/auth/verify", { key: k, body: {} });
    assert.equal(status, 401);
    assert.equal(env.code, 401);
    assert.equal(env.message, "UNAUTHORIZED");
  }
  const res = await fetch(`${base}/api/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("unknown action → 404 UNKNOWN_ACTION", async () => {
  const { status, env } = await rpc("/api/v1/nope/nothing", { body: {} });
  assert.equal(status, 404);
  assert.equal(env.message, "UNKNOWN_ACTION");
});

test("implemented action with missing args → 400 INVALID_ARGUMENT (DomainError passthrough)", async () => {
  const { status, env } = await rpc("/api/v1/asset/create", { body: {} });
  assert.equal(status, 400);
  assert.equal(env.message, "INVALID_ARGUMENT");
  assert.equal(typeof env.data.detail, "string");
});

test("non-POST on business route → 405 METHOD_NOT_ALLOWED", async () => {
  const { status, env } = await rpc("/api/v1/auth/verify", { method: "GET" });
  assert.equal(status, 405);
  assert.equal(env.message, "METHOD_NOT_ALLOWED");
});

test("foreign Origin → 403 FORBIDDEN; allowed Origin passes", async () => {
  const bad = await rpc("/api/v1/auth/verify", { body: {}, origin: "http://evil.example" });
  assert.equal(bad.status, 403);
  assert.equal(bad.env.message, "FORBIDDEN");

  const good = await rpc("/api/v1/auth/verify", { body: {}, origin: "http://localhost:5173" });
  assert.equal(good.status, 200);
});

test("invalid JSON body → 400 INVALID_ARGUMENT", async () => {
  const res = await fetch(`${base}/api/v1/auth/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Envelope).message, "INVALID_ARGUMENT");
});

test("/dl/* : missing file → 404, traversal → 404", async () => {
  for (const p of ["/dl/ck.tgz", "/dl/..%2Fknowledge.db", "/dl/%2e%2e%2fknowledge.db"]) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
  }
});

test("/mcp GET → 405 (stateless POST only)", async () => {
  const res = await fetch(`${base}/mcp`);
  assert.equal(res.status, 405);
  assert.equal(((await res.json()) as Envelope).message, "METHOD_NOT_ALLOWED");
});
