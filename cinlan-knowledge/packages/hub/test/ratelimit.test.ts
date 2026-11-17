import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { closeDatabase, createUser, createUserKey, openDatabase, type Db } from "@cinlan/knowledge-core";
import type { Envelope } from "@cinlan/knowledge-sdk";
import { createHubServer } from "../src/server.js";
import { loadConfig, type HubConfig } from "../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../src/ratelimit.js";

/** 按 key 限流（api.md §2 `RATE_LIMITED`、§6 重试约定；sop.md A.3 后端补件）。 */

let dir: string;
let db: Db;
let yorkerKey: string;
let yorkerSecondKey: string;
let linKey: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ck-hub-ratelimit-"));
  db = openDatabase({ file: join(dir, "knowledge.db") });
  const yorker = createUser(db, { name: "yorker", display_name: "Yorker", is_system_admin: true });
  yorkerKey = createUserKey(db, yorker.id, "laptop").key;
  yorkerSecondKey = createUserKey(db, yorker.id, "desktop").key;
  const lin = createUser(db, { name: "lin", display_name: "Lin", is_system_admin: false });
  linKey = createUserKey(db, lin.id, "laptop").key;
});

after(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

interface Hub {
  base: string;
  close(): Promise<void>;
}

/** 每个用例起自己的 hub：限流状态在进程内存里，按 hub 实例各算各的。 */
async function hub(rateLimit?: HubConfig["limits"]["rateLimit"]): Promise<Hub> {
  const config: HubConfig = {
    dataDir: dir,
    listen: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
    limits: { maxBodyBytes: 1024 * 1024, maxContentBytes: 262144, maxFileBytes: 5242880, ...(rateLimit ? { rateLimit } : {}) },
    log: { level: "error" },
  };
  const server = createHubServer({ db, config });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

interface Reply {
  status: number;
  retryAfter: string | null;
  env: Envelope<Record<string, unknown>>;
}

async function call(h: Hub, key: string | null, action = "auth/verify", body: unknown = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${h.base}/api/v1/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), env: (await res.json()) as Reply["env"] };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

async function mcp(h: Hub, key: string): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  const res = await fetch(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(INITIALIZE),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as Record<string, unknown> };
}

/** 429 的统一样子：信封里的 `retry_after` 与 `Retry-After` 头是同一个秒数。 */
function assertLimited(r: Reply, window: number): number {
  assert.equal(r.status, 429, JSON.stringify(r.env));
  assert.equal(r.env.code, 429);
  assert.equal(r.env.message, "RATE_LIMITED");
  assert.match(r.env.request_id, /^req_[0-9a-f]{24}$/);
  assert.deepEqual(Object.keys(r.env.data).sort(), ["detail", "retry_after"]);
  assert.equal(r.env.data.detail, "rate limit exceeded");
  const wait = r.env.data.retry_after as number;
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= window, `retry_after = ${wait}`);
  assert.equal(r.retryAfter, String(wait));
  return wait;
}

test("rate limit: past the budget a key gets 429 RATE_LIMITED with Retry-After until the window rolls over", async () => {
  const h = await hub({ windowSeconds: 2, maxRequests: 3 });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await call(h, yorkerKey);
      assert.equal(r.status, 200);
      assert.equal(r.retryAfter, null);
    }
    const wait = assertLimited(await call(h, yorkerKey), 2);
    // 被拒的请求不续窗口：再打还是同一个窗口里的 429
    assert.ok(assertLimited(await call(h, yorkerKey), 2) <= wait);

    // 照 Retry-After 等完就恢复，并且拿回整份额度
    await new Promise((res) => setTimeout(res, wait * 1000 + 100));
    for (let i = 0; i < 3; i++) assert.equal((await call(h, yorkerKey)).status, 200);
    assertLimited(await call(h, yorkerKey), 2);
  } finally {
    await h.close();
  }
});

test("rate limit: the budget belongs to the key, not to the user or the hub", async () => {
  const h = await hub({ windowSeconds: 60, maxRequests: 2 });
  try {
    assert.equal((await call(h, yorkerKey)).status, 200);
    assert.equal((await call(h, yorkerKey)).status, 200);
    assertLimited(await call(h, yorkerKey), 60);

    // 同一个人的另一把 key、别人的 key 都不受影响
    assert.equal((await call(h, yorkerSecondKey)).status, 200);
    assert.equal((await call(h, linKey)).status, 200);
    assertLimited(await call(h, yorkerKey), 60);
  } finally {
    await h.close();
  }
});

test("rate limit: /mcp draws on the same budget and is refused with the same envelope", async () => {
  const h = await hub({ windowSeconds: 60, maxRequests: 2 });
  try {
    assert.equal((await call(h, linKey)).status, 200);
    assert.equal((await mcp(h, linKey)).status, 200);

    const refused = await mcp(h, linKey);
    assertLimited({ status: refused.status, retryAfter: refused.retryAfter, env: refused.body as unknown as Reply["env"] }, 60);
    assertLimited(await call(h, linKey), 60);
  } finally {
    await h.close();
  }
});

test("rate limit: only requests that carry a valid key are counted, whatever their outcome", async () => {
  const h = await hub({ windowSeconds: 60, maxRequests: 2 });
  try {
    // 认不出 key 的请求没有可记的桶：一直是 401，不会变成 429，也不占别人的额度
    const forged = `ck_${yorkerKey.slice(3, 11)}_${"1".repeat(32)}`;
    for (let i = 0; i < 5; i++) {
      assert.equal((await call(h, forged)).status, 401);
      assert.equal((await call(h, null)).status, 401);
    }
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${h.base}/healthz`)).status, 200);

    // 带着有效 key 的请求不论成败都记一次
    assert.equal((await call(h, yorkerKey, "asset/get", {})).status, 400);
    assert.equal((await call(h, yorkerKey)).status, 200);
    assertLimited(await call(h, yorkerKey, "asset/get", {}), 60);
  } finally {
    await h.close();
  }
});

test("rate limit: without limits.rateLimit the hub applies the default budget", async () => {
  assert.deepEqual(DEFAULT_RATE_LIMIT, { windowSeconds: 60, maxRequests: 600 });
  const h = await hub();
  try {
    for (let sent = 0; sent < DEFAULT_RATE_LIMIT.maxRequests; sent += 50) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => call(h, yorkerKey)));
      assert.deepEqual([...new Set(batch.map((r) => r.status))], [200], `after ${sent} requests`);
    }
    assertLimited(await call(h, yorkerKey), DEFAULT_RATE_LIMIT.windowSeconds);
  } finally {
    await h.close();
  }
});

test("config: limits.rateLimit is optional; a malformed one is listed with the other problems", () => {
  const load = (limits: unknown) => {
    const file = join(dir, "knowledge.config.json");
    writeFileSync(file, JSON.stringify({ dataDir: dir, limits }));
    return loadConfig(file);
  };

  assert.equal(load({}).config?.limits.rateLimit, undefined);
  assert.deepEqual(load({ rateLimit: { windowSeconds: 10, maxRequests: 30 } }).config?.limits.rateLimit, {
    windowSeconds: 10,
    maxRequests: 30,
  });

  const WINDOW = "limits.rateLimit.windowSeconds: positive integer";
  const MAX = "limits.rateLimit.maxRequests: positive integer";
  const bad: [unknown, string[]][] = [
    ["off", ["limits.rateLimit: object { windowSeconds, maxRequests }"]],
    [[60, 600], ["limits.rateLimit: object { windowSeconds, maxRequests }"]],
    [{}, [WINDOW, MAX]],
    [{ windowSeconds: 60 }, [MAX]],
    [{ windowSeconds: 0, maxRequests: 600 }, [WINDOW]],
    [{ windowSeconds: 1.5, maxRequests: 600 }, [WINDOW]],
    [{ windowSeconds: 60, maxRequests: -1 }, [MAX]],
    [{ windowSeconds: "60", maxRequests: "600" }, [WINDOW, MAX]],
  ];
  for (const [rateLimit, problems] of bad) {
    assert.deepEqual(load({ rateLimit }), { config: null, problems }, JSON.stringify(rateLimit));
  }
});
