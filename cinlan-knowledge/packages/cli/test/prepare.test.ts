import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrepareError, dropCache, loadoutCachePath, parseAgent, prepare } from "../src/prepare.js";
import type { ResolvedConfig } from "../src/config.js";
import { basicHub, hubFetch, resolveData } from "./support.js";

/**
 * 读档流水线（loadout.md §6）：成功 / not_modified / 网络故障兜底 / 吊销清缓存。
 */

const AGENT = { team: "core", name: "builder" };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ck-prepare-"));
}

function cfg(hub: string | null = "http://hub:8424", key: string | null = "ck_k"): ResolvedConfig {
  return { hub, key, sources: { hub: "env", key: "env" } };
}

function withHome(fn: (home: string) => Promise<void> | void): Promise<void> | void {
  const home = tempHome();
  const done = (): void => rmSync(home, { recursive: true, force: true });
  try {
    const maybe = fn(home);
    return maybe instanceof Promise ? maybe.finally(done) : done();
  } catch (err) {
    done();
    throw err;
  }
}

test("success: ensure → resolve → cache written atomically, items flattened", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("配装文本") }));
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl });
    assert.equal(out.agent_id, "ag_1");
    assert.equal(out.text, "配装文本");
    assert.equal(out.stale, false);
    assert.deepEqual(out.items, [{ asset_id: "ast_1", version: 1 }]);
    assert.deepEqual(hub.calls.map((c) => c.action), ["agent/ensure", "loadout/resolve"]);
    assert.deepEqual(hub.calls[0]!.body, { team: "core", name: "builder", host: "dsh" });
    const cache = JSON.parse(readFileSync(loadoutCachePath(home, "ag_1"), "utf8"));
    assert.equal(cache.text, "配装文本");
    assert.equal(cache.digest, out.digest);
  }));

test("second run sends if_digest and not_modified returns cached text", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("v1") })).fetchImpl });
    const hub = basicHub((body) => {
      assert.ok(typeof body["if_digest"] === "string", "if_digest carried from cache");
      return { data: { ...resolveData("ignored"), not_modified: true } };
    });
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl });
    assert.equal(out.text, "v1");
    assert.equal(out.stale, false);
  }));

test("not_modified with a changed skills[] list: fresh list returned and the cache refreshed (§5.4)", () =>
  withHome(async (home) => {
    const v1 = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("v1") })).fetchImpl });
    // skill 升到 v2 而摘要行不变：digest 不变 → hub 回 not_modified，但 skills[] 带新版本
    const skills2 = [{ asset_id: "ast_s", name: "audit", version: 2, content_hash: "h2" }];
    const hub = basicHub((body) =>
      body["if_digest"] === v1.digest
        ? { data: { ...resolveData("ignored"), not_modified: true, text: "", items: [{ asset_id: "ast_1", version: 1 }], skills: skills2 } }
        : { data: resolveData("v1") },
    );
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl });
    // 文本沿用缓存；清单取本次应答
    assert.equal(out.text, "v1");
    assert.equal(out.stale, false);
    assert.deepEqual(out.skills, skills2);
    // 缓存里的清单也刷新——网络兜底那条路不会退回旧版本
    const cache = JSON.parse(readFileSync(loadoutCachePath(home, "ag_1"), "utf8"));
    assert.deepEqual(cache.skills, skills2);
    assert.equal(cache.text, "v1");
    assert.equal(cache.digest, v1.digest);
  }));

test("fresh: resolve carries no if_digest even with a cache, and the cache takes the full result", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("v1") })).fetchImpl });
    // skill 出了新版而摘要没变：文本不变（skill 行是 name + summary），digest 也就不变。
    // fresh 不带 if_digest，直接拿全量应答（真 hub 在 not_modified 里也返回 skills[]，§5.4）。
    const skills = [{ asset_id: "ast_s", name: "audit", version: 2, content_hash: "h2" }];
    const full = resolveData("v1", { skills });
    const hub = basicHub((body) =>
      body["if_digest"] === full["digest"] ? { data: { ...full, not_modified: true, text: "", items: [], skills: [] } } : { data: full },
    );
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fresh: true, fetchImpl: hub.fetchImpl });
    assert.deepEqual(hub.calls[1]!.body, { agent_id: "ag_1" });
    assert.deepEqual(out.skills, skills);
    assert.deepEqual(JSON.parse(readFileSync(loadoutCachePath(home, "ag_1"), "utf8")).skills, skills);
  }));

test("fresh: a network failure on resolve is an error even with a cache", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("cached") })).fetchImpl });
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fresh: true, fetchImpl: basicHub(() => "network").fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), true, "a network failure is not a revocation: the cache stays for the next automatic run");
  }));

test("budget passes through to resolve", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("x") }));
    await prepare({
      config: cfg(),
      agent: AGENT,
      host: "dsh",
      home,
      fetchImpl: hub.fetchImpl,
      budgetChars: 12000,
      maxBytes: 24000,
    });
    assert.deepEqual(hub.calls[1]!.body.budget_chars, 12000);
    assert.deepEqual(hub.calls[1]!.body.max_bytes, 24000);
  }));

test("network failure with cache → stale output, cached digest and fetched_at", () =>
  withHome(async (home) => {
    const first = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("cached") })).fetchImpl });
    const hub = basicHub(() => "network");
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl });
    assert.equal(out.stale, true);
    assert.equal(out.text, "cached");
    assert.equal(out.fetched_at, first.fetched_at);
  }));

test("network failure without cache → PrepareError UNAVAILABLE", () =>
  withHome(async (home) => {
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => "network").fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
  }));

test("FORBIDDEN on resolve → error, cache dropped", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("old") })).fetchImpl });
    assert.ok(existsSync(loadoutCachePath(home, "ag_1")));
    const hub = basicHub(() => ({ code: 403, message: "FORBIDDEN" }));
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "FORBIDDEN",
    );
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), false, "cache must not survive revocation");
  }));

test("agent/ensure 401 → PrepareError UNAUTHORIZED before any resolve", () =>
  withHome(async (home) => {
    const hub = hubFetch(() => ({ code: 401, message: "UNAUTHORIZED" }));
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAUTHORIZED",
    );
    assert.deepEqual(hub.calls.map((c) => c.action), ["agent/ensure"]);
  }));

test("hub unreachable from the first call, with cache → stale output", () =>
  withHome(async (home) => {
    const first = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("cached") })).fetchImpl });
    // hub 整个不可达：agent/ensure 就失败，拿不到 agent_id，仍要找回这个 Agent 的缓存
    const hub = hubFetch(() => "network");
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl });
    assert.equal(out.stale, true);
    assert.equal(out.text, "cached");
    assert.equal(out.agent_id, "ag_1");
    assert.equal(out.team_id, "tem_1");
    assert.equal(out.fetched_at, first.fetched_at);
    assert.deepEqual(hub.calls.map((c) => c.action), ["agent/ensure"]);
  }));

test("hub unreachable from the first call, cache belongs to another agent → UNAVAILABLE", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("cached") })).fetchImpl });
    await assert.rejects(
      () => prepare({ config: cfg(), agent: { team: "core", name: "other" }, host: "dsh", home, fetchImpl: hubFetch(() => "network").fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
    // 换了 hub 也不认：agent_id 只在签发它的 hub 上有意义
    await assert.rejects(
      () => prepare({ config: cfg("http://other:8424"), agent: AGENT, host: "dsh", home, fetchImpl: hubFetch(() => "network").fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
  }));

/**
 * 慢 hub：每个动作晚 `delays[action]` 毫秒应答；请求的 signal 先中止，就像真 fetch 那样抛 AbortError。
 */
function slowHub(delays: Record<string, number>, text: string): typeof fetch {
  const inner = basicHub(() => ({ data: resolveData(text) })).fetchImpl;
  return (input, init) => {
    const url = String(input);
    const action = url.slice(url.indexOf("/api/v1/") + "/api/v1/".length);
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const abort = (): void => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal?.aborted) return abort();
      const timer = setTimeout(() => resolve(inner(input, init)), delays[action] ?? 0);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        abort();
      });
    });
  };
}

test("the time limit covers ensure and resolve together: a slow ensure leaves resolve only the remainder", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("cached") })).fetchImpl });
    // 两步各 400ms，单看都在 600ms 以内；合计 800ms 超限：resolve 在第 600ms 被掐断，按网络故障走缓存（loadout.md §6）
    const out = await prepare({
      config: cfg(),
      agent: AGENT,
      host: "dsh",
      home,
      timeoutMs: 600,
      fetchImpl: slowHub({ "agent/ensure": 400, "loadout/resolve": 400 }, "fresh"),
    });
    assert.equal(out.stale, true);
    assert.equal(out.text, "cached");
  }));

test("a quick ensure leaves resolve the rest of the limit", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("cached") })).fetchImpl });
    // ensure 50ms + resolve 150ms = 200ms，在 600ms 以内：resolve 不能被提前掐断
    const out = await prepare({
      config: cfg(),
      agent: AGENT,
      host: "dsh",
      home,
      timeoutMs: 600,
      fetchImpl: slowHub({ "agent/ensure": 50, "loadout/resolve": 150 }, "fresh"),
    });
    assert.equal(out.stale, false);
    assert.equal(out.text, "fresh");
  }));

test("T8: key revoked → agent/ensure 401 → error, cache never read, that agent's cache file deleted", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("old") }), "ag_1").fetchImpl });
    await prepare({ config: cfg(), agent: { team: "core", name: "other" }, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("keep") }), "ag_2").fetchImpl });
    const hub = hubFetch(() => ({ code: 401, message: "UNAUTHORIZED" }));
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAUTHORIZED",
    );
    assert.deepEqual(hub.calls.map((c) => c.action), ["agent/ensure"]);
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), false, "revoked agent's cache must go");
    assert.equal(existsSync(loadoutCachePath(home, "ag_2")), true, "other agents' cache stays");
    // 之后 hub 再不可达也不会拿旧缓存出来读档
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hubFetch(() => "network").fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
  }));

test("agent/ensure 404 (removed from team) → cache dropped as well", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("old") })).fetchImpl });
    await assert.rejects(
      () => prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: hubFetch(() => ({ code: 404, message: "NOT_FOUND" })).fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "NOT_FOUND",
    );
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), false);
  }));

test("missing hub/key → PrepareError before network", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("x") }));
    await assert.rejects(
      () => prepare({ config: cfg(null, "k"), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
    await assert.rejects(
      () => prepare({ config: cfg("http://h", null), agent: AGENT, host: "dsh", home, fetchImpl: hub.fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAUTHORIZED",
    );
    assert.equal(hub.calls.length, 0);
  }));

test("brief baseline skips resolve and does not touch the cache", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("x") }));
    const out = await prepare({ config: cfg(), agent: AGENT, host: "claude-code", baseline: "brief", home, fetchImpl: hub.fetchImpl });
    assert.equal(out.text, "");
    assert.deepEqual(hub.calls.map((c) => c.action), ["agent/ensure"]);
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), false);
  }));

test("corrupt cache file is ignored, not fatal", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("v1") })).fetchImpl });
    const file = loadoutCachePath(home, "ag_1");
    rmSync(file);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{broken");
    const out = await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("v2") })).fetchImpl });
    assert.equal(out.text, "v2");
  }));

test("parseAgent rejects malformed values", () => {
  assert.deepEqual(parseAgent("core/builder"), { team: "core", name: "builder" });
  for (const bad of ["", "core", "/builder", "core/", "a/b/c"]) {
    assert.throws(() => parseAgent(bad), /<team>\/<name>/);
  }
});

test("dropCache removes only the target agent file", () =>
  withHome(async (home) => {
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("x") }), "ag_1").fetchImpl });
    await prepare({ config: cfg(), agent: AGENT, host: "dsh", home, fetchImpl: basicHub(() => ({ data: resolveData("y") }), "ag_2").fetchImpl });
    dropCache(home, "ag_1");
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), false);
    assert.equal(existsSync(loadoutCachePath(home, "ag_2")), true);
  }));
