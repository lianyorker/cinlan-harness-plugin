import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook.js";
import { loadoutCachePath } from "../src/prepare.js";
import type { ResolvedConfig } from "../src/config.js";
import { basicHub, hubFetch, resolveData } from "./support.js";

/**
 * `ck hook session-start`（loadout.md §4）：stdout 只有协议 JSON、永不非 0 退出、
 * 超预算整段改投 brief、缓存兜底带提示。
 */

const AGENT = { team: "core", name: "builder" };

function cfg(hub: string | null = "http://hub:8424", key: string | null = "ck_k"): ResolvedConfig {
  return { hub, key, sources: { hub: "env", key: "env" } };
}

function withHome(fn: (home: string) => Promise<void> | void): Promise<void> | void {
  const home = mkdtempSync(join(tmpdir(), "ck-hook-"));
  const done = (): void => rmSync(home, { recursive: true, force: true });
  try {
    const maybe = fn(home);
    return maybe instanceof Promise ? maybe.finally(done) : done();
  } catch (err) {
    done();
    throw err;
  }
}

function contextOf(json: Record<string, unknown>): string {
  const out = json["hookSpecificOutput"] as { hookEventName?: unknown; additionalContext?: unknown } | undefined;
  assert.equal(out?.hookEventName, "SessionStart");
  assert.equal(typeof out?.additionalContext, "string");
  return out!.additionalContext as string;
}

test("success → claude-code hook JSON with the loadout text, exit 0", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("体量适中的配装文本") }));
    const out = await runHook({ config: cfg(), agent: AGENT, host: "claude-code", budgetChars: 8000, home, fetchImpl: hub.fetchImpl });
    assert.equal(out.exitCode, 0);
    assert.equal(contextOf(out.json), "体量适中的配装文本");
  }));

test("over budget → whole text replaced by brief + reload hint, not truncated", () =>
  withHome(async (home) => {
    const long = "x".repeat(500);
    const hub = basicHub(() => ({ data: resolveData(long) }));
    const out = await runHook({ config: cfg(), agent: AGENT, host: "claude-code", budgetChars: 200, home, fetchImpl: hub.fetchImpl });
    const text = contextOf(out.json);
    assert.ok(!text.includes(long), "must not ship the oversized text");
    assert.ok(text.includes("<cinlan_knowledge_brief"), "falls back to the brief block");
    assert.ok(text.includes("请调用 knowledge_status（reload: true）读取团队配装。"));
    assert.equal(out.exitCode, 0);
  }));

test("budget is measured on the encoded JSON, not the raw text", () =>
  withHome(async (home) => {
    // 原文 160 字符但含大量引号，编码后显著变长；阈值卡在两者之间。
    const text = '"'.repeat(160);
    const encoded = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }).length;
    assert.ok(encoded > text.length + 20);
    const hub = basicHub(() => ({ data: resolveData(text) }));
    const out = await runHook({ config: cfg(), agent: AGENT, host: "claude-code", budgetChars: text.length + 10, home, fetchImpl: hub.fetchImpl });
    assert.ok(!contextOf(out.json).includes(text));
  }));

test("stale cache → notice prepended with fetched_at, text kept", () =>
  withHome(async (home) => {
    await runHook({
      config: cfg(),
      agent: AGENT,
      host: "claude-code",
      budgetChars: 8000,
      home,
      fetchImpl: basicHub(() => ({ data: resolveData("缓存的配装") })).fetchImpl,
    });
    const { fetched_at: fetchedAt } = JSON.parse(readFileSync(loadoutCachePath(home, "ag_1"), "utf8")) as { fetched_at: string };
    const out = await runHook({ config: cfg(), agent: AGENT, host: "claude-code", budgetChars: 8000, home, fetchImpl: basicHub(() => "network").fetchImpl });
    // 字面量以 loadout.md §3 为准，与 `ck mcp` 的缓存兜底同一句
    assert.equal(
      contextOf(out.json),
      `<cinlan_knowledge_notice stale="true" fetched_at="${fetchedAt}">hub 暂不可达，以下配装来自本机缓存。</cinlan_knowledge_notice>\n缓存的配装`,
    );
    assert.equal(out.exitCode, 0);
  }));

test("prepare failure → error block with the code, exit still 0", () =>
  withHome(async (home) => {
    const hub = hubFetch(() => ({ code: 401, message: "UNAUTHORIZED" }));
    const out = await runHook({ config: cfg(), agent: AGENT, host: "claude-code", budgetChars: 8000, home, fetchImpl: hub.fetchImpl });
    const text = contextOf(out.json);
    assert.ok(text.includes('error="UNAUTHORIZED"'));
    assert.ok(text.includes("knowledge_status"));
    assert.equal(out.exitCode, 0);
  }));

test("T8: key revoked after a good run → error block without the cached text, cache file deleted", () =>
  withHome(async (home) => {
    await runHook({
      config: cfg(),
      agent: AGENT,
      host: "claude-code",
      budgetChars: 8000,
      home,
      fetchImpl: basicHub(() => ({ data: resolveData("缓存的配装") })).fetchImpl,
    });
    assert.ok(existsSync(loadoutCachePath(home, "ag_1")));
    const hub = hubFetch(() => ({ code: 401, message: "UNAUTHORIZED" }));
    const out = await runHook({ config: cfg(), agent: AGENT, host: "claude-code", budgetChars: 8000, home, fetchImpl: hub.fetchImpl });
    const text = contextOf(out.json);
    assert.ok(text.includes('error="UNAUTHORIZED"'));
    assert.ok(!text.includes("缓存的配装"), "revoked key must not be served from cache");
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), false);
    assert.equal(out.exitCode, 0);
  }));

test("unconfigured hub → error block, exit 0, no network", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("x") }));
    const out = await runHook({ config: cfg(null, "k"), agent: AGENT, host: "claude-code", budgetChars: 8000, home, fetchImpl: hub.fetchImpl });
    assert.ok(contextOf(out.json).includes('error="UNAVAILABLE"'));
    assert.equal(hub.calls.length, 0);
  }));

test("hermes-context output → {context: text}，无 hookSpecificOutput 壳", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("首轮配装") }));
    const out = await runHook({
      config: cfg(),
      agent: AGENT,
      host: "hermes",
      budgetChars: 8000,
      output: "hermes-context",
      home,
      fetchImpl: hub.fetchImpl,
    });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(out.json, { context: "首轮配装" });
  }));

test("hermes-context / prepare 失败 → 同一个 {context} 形状的错误块", () =>
  withHome(async (home) => {
    const hub = hubFetch(() => ({ code: 401, message: "UNAUTHORIZED" }));
    const out = await runHook({
      config: cfg(),
      agent: AGENT,
      host: "hermes",
      budgetChars: 8000,
      output: "hermes-context",
      home,
      fetchImpl: hub.fetchImpl,
    });
    assert.equal(out.exitCode, 0);
    const text = out.json["context"] as string;
    assert.ok(text.includes('error="UNAUTHORIZED"'));
    assert.ok(text.includes("knowledge_status"));
    assert.equal(out.json["hookSpecificOutput"], undefined);
  }));
