import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "../src/hosts.js";
import type { ResolvedConfig } from "../src/config.js";
import { KnowledgeRpcError } from "@cinlan/knowledge-mcp";
import { INJECTED_DEDUPE_MS, createCliSession } from "../src/mcp.js";
import { basicHub, hubFetch, resolveData, withSplitHomes } from "./support.js";

/**
 * `ck mcp` 会话装配：instructions 三种出口、`injected` 上报与 60 秒去重、后台物化不拦工具。
 */

const AGENT = { team: "core", name: "builder" };

function cfg(hub: string | null = "http://hub:8424", key: string | null = "ck_k"): ResolvedConfig {
  return { hub, key, sources: { hub: "env", key: "env" } };
}

function host(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    name: "claude-code",
    title: "test",
    mcp: { file: "", format: "json", key: "mcpServers.ck", insert: false },
    hook: null,
    instructions: "full",
    budgets: {},
    skill_dir: "~/.claude/skills",
    ...overrides,
  };
}

function withHome(fn: (home: string) => Promise<void> | void): Promise<void> | void {
  const home = mkdtempSync(join(tmpdir(), "ck-mcp-"));
  const done = (): void => rmSync(home, { recursive: true, force: true });
  try {
    const maybe = fn(home);
    return maybe instanceof Promise ? maybe.finally(done) : done();
  } catch (err) {
    done();
    throw err;
  }
}

/** usage/report 是 fire-and-forget；等到它落地或超时。 */
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met before deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function reports(hub: { calls: { action: string; body: Record<string, unknown> }[] }) {
  return hub.calls.filter((c) => c.action === "usage/report");
}

/** 上报是 fire-and-forget，`calls` 先落地；标记文件在信封返回之后才写。 */
function markerPath(home: string): string {
  return join(home, "cache", "injected-ag_1.json");
}

/** 读标记文件里的 digest；文件还没写好（缺/坏 JSON）返回 null。
 *  清理前等它等于预期 digest，才不会在 markReported 重写途中 rmSync 留下半截目录（§6.10 泄漏）。 */
function markerDigest(home: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(home), "utf8")) as { digest?: unknown };
    return typeof parsed.digest === "string" ? parsed.digest : null;
  } catch {
    return null;
  }
}

test("full baseline → resolved text, one injected report with every item", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("配装") }));
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.equal(await session.instructions(), "配装");
    await until(() => reports(hub).length === 1);
    await until(() => markerDigest(home) === "digest-2-配装");
    assert.deepEqual(reports(hub)[0]!.body, {
      agent_id: "ag_1",
      events: [{ asset_id: "ast_1", version: 1, kind: "injected" }],
    });
    assert.equal(session.ctx.agent_id, "ag_1");
    assert.equal(session.ctx.baseline, "full");
    await background;
  }));

test("instructions is computed once and cached in the session", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("配装") }));
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    const first = await session.instructions();
    const second = await session.instructions();
    assert.equal(first, second);
    await until(() => reports(hub).length === 1);
    await until(() => markerDigest(home) === "digest-2-配装");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reports(hub).length, 1, "second read must not report again");
    await background;
  }));

test("same agent + digest inside 60s → no second injected report", () =>
  withHome(async (home) => {
    const hub1 = basicHub(() => ({ data: resolveData("配装") }));
    const one = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub1.fetchImpl });
    await one.session.instructions();
    await until(() => reports(hub1).length === 1);
    await until(() => existsSync(markerPath(home)));
    await one.background;
    assert.ok(existsSync(markerPath(home)), "dedupe marker written");

    const hub2 = basicHub(() => ({ data: resolveData("配装") }));
    const two = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub2.fetchImpl });
    await two.session.instructions();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reports(hub2).length, 0, "same digest inside the window must not re-report");
    await two.background;
  }));

test("different digest → reports even inside the window", () =>
  withHome(async (home) => {
    const hub1 = basicHub(() => ({ data: resolveData("v1") }));
    const one = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub1.fetchImpl });
    await one.session.instructions();
    await until(() => reports(hub1).length === 1);
    await until(() => markerDigest(home) === "digest-2-v1");
    await one.background;

    const hub2 = basicHub(() => ({ data: resolveData("v2-changed") }));
    const two = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub2.fetchImpl });
    await two.session.instructions();
    await until(() => reports(hub2).length === 1);
    await until(() => markerDigest(home) === "digest-10-v2-c");
    await two.background;
  }));

test("expired dedupe marker no longer suppresses", () =>
  withHome(async (home) => {
    const hub1 = basicHub(() => ({ data: resolveData("配装") }));
    const one = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub1.fetchImpl });
    await one.session.instructions();
    await until(() => reports(hub1).length === 1);
    await until(() => existsSync(markerPath(home)));
    await one.background;

    // 伪造一个过期时间戳：digest 相同但已出窗口
    const file = markerPath(home);
    const state = JSON.parse(readFileSync(file, "utf8")) as { digest: string; at: number };
    const { writeFileSync } = await import("node:fs");
    const staleAt = Date.now() - INJECTED_DEDUPE_MS - 1;
    writeFileSync(file, JSON.stringify({ digest: state.digest, at: staleAt }));

    const hub2 = basicHub(() => ({ data: resolveData("配装") }));
    const two = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub2.fetchImpl });
    await two.session.instructions();
    await until(() => reports(hub2).length === 1);
    // 标记会被重写成新 at（digest 相同），等它落地，别让 markReported 撞上清理（§6.10 泄漏同款）。
    await until(() => {
      const rewritten = JSON.parse(readFileSync(markerPath(home), "utf8")) as { at?: number };
      return typeof rewritten.at === "number" && rewritten.at > staleAt;
    });
    await two.background;
  }));

test("brief baseline → brief block, no report", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("不该被取") }));
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, baseline: "brief", home, fetchImpl: hub.fetchImpl });
    const text = await session.instructions();
    assert.ok(text.includes("<cinlan_knowledge_brief"));
    assert.ok(text.includes('team="core"'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reports(hub).length, 0);
    await background;
  }));

test("over-limit text → brief fallback, no report", () =>
  withHome(async (home) => {
    const hub = basicHub(() => ({ data: resolveData("x".repeat(13000)) }));
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    const text = await session.instructions();
    assert.ok(text.includes("<cinlan_knowledge_brief"), "must fall back to brief, never truncate");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reports(hub).length, 0, "brief fallback is not an injection");
    await background;
  }));

test("stale cache → notice prefix, no report", () =>
  withHome(async (home) => {
    const first = basicHub(() => ({ data: resolveData("缓存文本") }));
    const one = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: first.fetchImpl });
    await one.session.instructions();
    await until(() => reports(first).length === 1);
    await one.background;

    const { fetched_at: fetchedAt } = JSON.parse(readFileSync(join(home, "cache", "loadout-ag_1.json"), "utf8")) as { fetched_at: string };

    const offline = basicHub(() => "network");
    const two = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: offline.fetchImpl });
    const text = await two.session.instructions();
    // 缓存提示的字面量以 loadout.md §3 为准：hook 与 mcp 两条路径是同一句
    assert.equal(
      text,
      `<cinlan_knowledge_notice stale="true" fetched_at="${fetchedAt}">hub 暂不可达，以下配装来自本机缓存。</cinlan_knowledge_notice>\n缓存文本`,
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reports(offline).length, 0);
    await two.background;
  }));

test("prepare failure with hub configured → error instructions, tools still served", () =>
  withHome(async (home) => {
    const hub = hubFetch((action) => {
      if (action === "agent/ensure") return { code: 403, message: "FORBIDDEN" };
      return { code: 404, message: "NOT_FOUND" };
    });
    const { session, prepared, failure, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.equal(prepared, null);
    assert.equal(failure?.code, "FORBIDDEN");
    const text = await session.instructions();
    assert.ok(text.includes('error="FORBIDDEN"'));
    assert.ok(text.includes("knowledge_status"));
    assert.equal(session.rpc.server_version.length > 0, true);
    await background;
  }));

test("no hub/key → UNAVAILABLE error instructions and an rpc that rejects with the reason", () =>
  withHome(async (home) => {
    const { session, failure, background } = await createCliSession({
      config: cfg(null, null),
      host: host(),
      agent: AGENT,
      home,
      fetchImpl: hubFetch(() => ({ data: {} })).fetchImpl,
    });
    assert.equal(failure?.code, "UNAVAILABLE");
    assert.ok((await session.instructions()).includes('error="UNAVAILABLE"'));
    await assert.rejects(
      () => session.rpc.call("knowledge/search", {}),
      (err: unknown) => err instanceof KnowledgeRpcError && err.code === "UNAVAILABLE",
    );
    await background;
  }));

test("tool calls run as the session agent and keep the hub's error text", () =>
  withHome(async (home) => {
    const hub = hubFetch((action) => {
      if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1" } } };
      if (action === "loadout/resolve") return { data: resolveData("配装") };
      if (action === "asset/get") return { data: { asset: { id: "ast_1" } } };
      return { code: 409, message: "VERSION_CONFLICT", data: { detail: "base_version is not current", current_version: 2 } };
    });
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.equal(session.ctx.team_id, "tem_1", "team_id is the id from agent/ensure, not the slug");
    assert.equal(session.ctx.team_name, "core");

    // 工具调用带 x-ck-agent-id：权限与 opened 记账才和 hub /mcp 一致
    await session.rpc.call("asset/get", { asset_id: "ast_1" });
    assert.equal(hub.calls.at(-1)!.agent, "ag_1");

    // 错误文本与 hub /mcp 同形：`CODE: 说明`，detail 不留在 data 里
    await assert.rejects(
      () => session.rpc.call("asset/update", { asset_id: "ast_1", base_version: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof KnowledgeRpcError);
        assert.equal(err.code, "VERSION_CONFLICT");
        assert.equal(err.message, "VERSION_CONFLICT: base_version is not current");
        assert.deepEqual(err.data, { current_version: 2 });
        return true;
      },
    );
    await background;
  }));

test("prepare failed → tool calls carry no agent header", () =>
  withHome(async (home) => {
    const hub = hubFetch((action) => {
      if (action === "agent/ensure") return { code: 403, message: "FORBIDDEN", data: { detail: "not a team member" } };
      return { data: {} };
    });
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.equal(session.ctx.agent_id, null);
    assert.equal(session.ctx.team_id, null);
    await session.rpc.call("auth/verify", {});
    assert.equal(hub.calls.at(-1)!.agent, null);
    await background;
  }));

test("background materializes skills and does not reject on sync failure", () =>
  withHome(async (home) => {
    const skills = [{ asset_id: "ast_s", name: "audit", version: 1, content_hash: "h" }];
    const hub = hubFetch((action, body) => {
      if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1" } } };
      if (action === "loadout/resolve") return { data: resolveData("配装", { skills }) };
      if (action === "usage/report") return { data: {} };
      return { code: 500, message: "INTERNAL" }; // asset/get 失败
    });
    const { background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    await background; // 不能抛
    assert.equal(existsSync(join(home, ".claude", "skills", "audit")), false);
  }));

/** `<home>/logs/ck.log` 里某个事件的全部行。 */
function logged(home: string, event: string): Record<string, unknown>[] {
  const file = join(home, "logs", "ck.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["event"] === event);
}

/** 配装里带 inject skill 的假 hub：`asset/get` 对任何 skill 都回同一份正文。 */
function skillHub(skills: { asset_id: string; name: string; version: number; content_hash: string }[]) {
  return hubFetch((action) => {
    if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1" } } };
    if (action === "loadout/resolve") return { data: resolveData("配装", { skills }) };
    if (action === "asset/get") return { data: { version: { content: "技能正文" }, files: [] } };
    if (action === "usage/report") return { data: {} };
    return { code: 404, message: "NOT_FOUND" };
  });
}

const AUDIT = { asset_id: "ast_s", name: "audit", version: 1, content_hash: "h" };
const NOTES = { asset_id: "ast_n", name: "notes", version: 1, content_hash: "h" };

test("an already materialized skill is not logged as a conflict", () =>
  withHome(async (home) => {
    const one = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: skillHub([AUDIT]).fetchImpl });
    await one.background;
    assert.equal(readFileSync(join(home, ".claude", "skills", "audit", "SKILL.md"), "utf8"), "技能正文");

    // 第二次启动内容没变：物化结果是 unchanged，不是冲突
    const two = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: skillHub([AUDIT]).fetchImpl });
    await two.background;
    assert.deepEqual(logged(home, "mcp.skills_conflict"), []);
  }));

test("a same-name directory ck did not write is logged as a conflict, without the unchanged skills", () =>
  withHome(async (home) => {
    const one = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: skillHub([AUDIT]).fetchImpl });
    await one.background;
    // 本机手写的同名目录：没有标记文件
    mkdirSync(join(home, ".claude", "skills", "notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "notes", "SKILL.md"), "手写的");

    const two = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: skillHub([AUDIT, NOTES]).fetchImpl });
    await two.background;
    const entries = logged(home, "mcp.skills_conflict");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!["agent_id"], "ag_1");
    assert.deepEqual(entries[0]!["skipped"], [{ name: "notes", reason: "conflict" }]);
    assert.equal(readFileSync(join(home, ".claude", "skills", "notes", "SKILL.md"), "utf8"), "手写的");
  }));

test("session facts: digest from the loadout, stale false, skills snapshot filled by the background (§5.3)", () =>
  withHome(async (home) => {
    const skills = [{ asset_id: "ast_s", name: "audit", version: 1, content_hash: "h" }];
    const hub = skillHub(skills);
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    await session.instructions();
    const facts = session.ctx.session!;
    // digest 就是投递文本的 digest；物化还没跑完 → 快照是 null
    assert.equal(facts.digest, resolveData("配装", { skills }).digest);
    assert.equal(facts.stale, false);
    assert.equal(facts.skills, null, "no snapshot before the background run finishes");
    await background;
    assert.deepEqual(facts.skills, { materialized: 1, conflicts: [] });
  }));

test("session facts: stale when the text came from the local cache (§5.3)", () =>
  withHome(async (home) => {
    // 先落一份缓存，再让 hub 不可达 → prepare 走缓存兜底
    await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: skillHub([]).fetchImpl }).then((s) => s.background);
    const hub = hubFetch(() => "network");
    const { session, background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    await session.instructions();
    assert.equal(session.ctx.session!.stale, true);
    await background;
  }));

test("without a home option, skills land under the user home while the cache stays in CK_HOME", () =>
  withSplitHomes(async ({ userHome, stateHome }) => {
    const skills = [{ asset_id: "ast_s", name: "audit", version: 1, content_hash: "h" }];
    const hub = hubFetch((action) => {
      if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1" } } };
      if (action === "loadout/resolve") return { data: resolveData("配装", { skills }) };
      if (action === "asset/get") return { data: { version: { content: "技能正文" }, files: [] } };
      return { code: 404, message: "NOT_FOUND" };
    });
    const { background } = await createCliSession({ config: cfg(), host: host(), agent: AGENT, fetchImpl: hub.fetchImpl });
    await background;
    const skillFile = join(userHome, ".claude", "skills", "audit", "SKILL.md");
    assert.equal(existsSync(skillFile), true, "skill must land under the user home");
    assert.equal(readFileSync(skillFile, "utf8"), "技能正文");
    assert.equal(existsSync(join(stateHome, ".claude")), false, "host skill dir must not appear under the ck state dir");
    assert.equal(existsSync(join(stateHome, "cache", "loadout-ag_1.json")), true, "loadout cache belongs to the ck state dir");
    assert.equal(existsSync(join(userHome, "cache")), false, "ck state must not leak into the user home");
  }));
