import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { closeDatabase, createUser, createUserKey, openDatabase, type Db } from "@cinlan/knowledge-core";
import { createHubServer } from "../src/server.js";
import type { HubConfig } from "../src/config.js";

const INDEX = '<!doctype html><html lang="zh-CN"><head><title>panel</title></head><body><div id="root"></div></body></html>';
const SECRET = "TOP-SECRET-OUTSIDE-PANEL";

let dir: string;
let db: Db;
let key: string;
const servers: Server[] = [];

function configOf(host: string, allowedOrigins: string[] = []): HubConfig {
  return {
    dataDir: dir,
    listen: { host, port: 0, allowedOrigins },
    limits: { maxBodyBytes: 1024 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880 },
    log: { level: "error" },
  };
}

/** 监听一律落在 127.0.0.1；`host` 只是配置里声明的那个值（决定 hub 把哪些源当成自己）。 */
async function start(host: string, opts: { panelDir?: string; allowedOrigins?: string[] } = {}): Promise<{ base: string; port: number }> {
  const server = createHubServer({ db, config: configOf(host, opts.allowedOrigins), panelDir: opts.panelDir });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
}

/** fetch 会先把 `..` 规整掉，路径穿越要用原始请求行发。 */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function verify(base: string, origin?: string): Promise<Response> {
  return fetch(`${base}/api/v1/auth/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: "{}",
  });
}

let panelDir: string;
let hub: { base: string; port: number };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-panel-"));
  db = openDatabase({ file: join(dir, "knowledge.db") });
  const user = createUser(db, { name: "yorker", display_name: "Yorker", is_system_admin: true });
  key = createUserKey(db, user.id, "test").key;

  panelDir = join(dir, "panel-dist");
  mkdirSync(join(panelDir, "assets"), { recursive: true });
  writeFileSync(join(panelDir, "index.html"), INDEX);
  writeFileSync(join(panelDir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(panelDir, "assets", "index-abc123.js"), "console.log('panel')");
  writeFileSync(join(panelDir, "assets", "index-abc123.css"), "body{margin:0}");
  writeFileSync(join(dir, "secret.txt"), SECRET);

  hub = await start("127.0.0.1", { panelDir });
});

after(async () => {
  for (const server of servers) await new Promise<void>((res) => server.close(() => res()));
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

test("GET /panel/ 回 index.html：不缓存、带 CSP 与 nosniff", async () => {
  const res = await fetch(`${hub.base}/panel/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const csp = res.headers.get("content-security-policy") ?? "";
  for (const part of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(part), `CSP lacks ${part}: ${csp}`);
  }
  assert.equal(await res.text(), INDEX);
});

test("GET /panel 跳到 /panel/", async () => {
  const res = await fetch(`${hub.base}/panel`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/panel/");
});

test("带 hash 的构建产物：按扩展名给类型，长缓存", async () => {
  const js = await fetch(`${hub.base}/panel/assets/index-abc123.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await js.text(), "console.log('panel')");

  const css = await fetch(`${hub.base}/panel/assets/index-abc123.css`);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");

  // assets/ 之外的文件名不带 hash，不能长缓存
  const icon = await fetch(`${hub.base}/panel/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  assert.equal(icon.headers.get("cache-control"), "no-cache");
});

test("SPA fallback：没有扩展名的前端路由回 index.html", async () => {
  for (const path of ["/panel/assets-list", "/panel/agents/agt_0123456789abcdef01234567", "/panel/teams/", "/panel/guide?from=login"]) {
    const res = await fetch(`${hub.base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(await res.text(), INDEX, path);
  }
});

test("缺失的静态文件回 404 信封，不拿 index.html 顶替", async () => {
  const res = await fetch(`${hub.base}/panel/assets/missing-000000.js`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const env = (await res.json()) as { code: number; message: string };
  assert.equal(env.code, 404);
  assert.equal(env.message, "NOT_FOUND");
});

test("路径穿越一律 404，读不到 panel 目录之外的文件", async () => {
  const attempts = [
    "/panel/../secret.txt",
    "/panel/%2e%2e/secret.txt",
    "/panel/..%2fsecret.txt",
    "/panel/..%5csecret.txt",
    "/panel/assets/..%2f..%2fsecret.txt",
    "/panel/assets/%2e%2e%5c%2e%2e%5csecret.txt",
    "/panel/%00.html",
    "/panel/%zz",
  ];
  for (const path of attempts) {
    const res = await rawGet(hub.port, path);
    assert.equal(res.status, 404, `${path} → ${res.status}`);
    assert.ok(!res.body.includes(SECRET), `${path} leaked the file`);
  }
});

test("/panel 只接受 GET / HEAD", async () => {
  const post = await fetch(`${hub.base}/panel/`, { method: "POST", body: "{}" });
  assert.equal(post.status, 405);
  assert.equal(((await post.json()) as { message: string }).message, "METHOD_NOT_ALLOWED");

  const head = await fetch(`${hub.base}/panel/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(INDEX)));
  assert.equal(await head.text(), "");
});

test("panel 没构建时 /panel/ 明说没构建，API 不受影响", async () => {
  const bare = await start("127.0.0.1");
  const empty = await start("127.0.0.1", { panelDir: join(dir, "no-such-dir") });
  for (const target of [bare, empty]) {
    const res = await fetch(`${target.base}/panel/`);
    assert.equal(res.status, 404);
    const env = (await res.json()) as { message: string; data: { detail: string } };
    assert.equal(env.message, "NOT_FOUND");
    assert.equal(env.data.detail, "panel is not built");
    assert.equal((await verify(target.base)).status, 200);
  }
});

test("Origin：allowedOrigins 留空时只放行 hub 自己的源", async () => {
  // 浏览器里的 panel 发同源 POST 也会带 Origin
  assert.equal((await verify(hub.base, `http://127.0.0.1:${hub.port}`)).status, 200);
  assert.equal((await verify(hub.base, `http://localhost:${hub.port}`)).status, 200);
  assert.equal((await verify(hub.base, `http://[::1]:${hub.port}`)).status, 200);

  // 同主机的别的端口、别的协议、别的名字都不是 hub 自己
  for (const origin of [`http://127.0.0.1:${hub.port + 1}`, `https://127.0.0.1:${hub.port}`, `http://evil.example:${hub.port}`, "null"]) {
    const res = await verify(hub.base, origin);
    assert.equal(res.status, 403, origin);
    assert.equal(((await res.json()) as { message: string }).message, "FORBIDDEN");
  }

  // /mcp 与 /panel 用同一条规则
  const mcp = (origin: string) =>
    fetch(`${hub.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", origin },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
  assert.notEqual((await mcp(`http://127.0.0.1:${hub.port}`)).status, 403);
  assert.equal((await mcp("http://evil.example")).status, 403);
  assert.equal((await fetch(`${hub.base}/panel/`, { headers: { origin: `http://127.0.0.1:${hub.port}` } })).status, 200);
  assert.equal((await fetch(`${hub.base}/panel/`, { headers: { origin: "http://evil.example" } })).status, 403);
});

test("Origin：监听通配地址时，自己的源只认回环名；别的名字要写进 allowedOrigins", async () => {
  const wild = await start("0.0.0.0", { allowedOrigins: ["http://cinlan-hub.internal:8424"] });
  assert.equal((await verify(wild.base, `http://127.0.0.1:${wild.port}`)).status, 200);
  assert.equal((await verify(wild.base, `http://localhost:${wild.port}`)).status, 200);
  assert.equal((await verify(wild.base, "http://cinlan-hub.internal:8424")).status, 200);
  assert.equal((await verify(wild.base, `http://192.168.1.20:${wild.port}`)).status, 403);
  assert.equal((await verify(wild.base, `http://0.0.0.0:${wild.port}`)).status, 403);
});

test("Origin：监听具体地址时，那个地址加端口就是自己的源", async () => {
  const named = await start("10.20.30.40");
  assert.equal((await verify(named.base, `http://10.20.30.40:${named.port}`)).status, 200);
  assert.equal((await verify(named.base, `http://10.20.30.41:${named.port}`)).status, 403);
});
