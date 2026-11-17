import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveSkill } from "@cinlan/knowledge-sdk";
import type { HostConfig } from "../src/hosts.js";
import { PrepareError, loadoutCachePath } from "../src/prepare.js";
import { runSkillsSync, syncSkills } from "../src/sync.js";
import type { ResolvedConfig } from "../src/config.js";
import { hubFetch, resolveData, withSplitHomes } from "./support.js";

/**
 * sync 入口：配置前置校验、`~` 展开、10 秒超时、asset/get 一律钉版本。
 * `ck skills sync`（runSkillsSync）：清单永远现取，不看宿主的 instructions 形态，也不走 digest 短路。
 */

const SKILL: ResolveSkill = { asset_id: "ast_1", name: "audit", version: 4, content_hash: "h" };
const AGENT = { team: "core", name: "builder" };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ck-sync-"));
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

function cfg(hub: string | null = "http://hub:8424", key: string | null = "ck_k"): ResolvedConfig {
  return { hub, key, sources: { hub: "env", key: "env" } };
}

function host(skillDir = "~/.agents/skills"): HostConfig {
  return {
    name: "dsh",
    title: "test",
    mcp: { file: "", format: "yaml", key: "ck", insert: true },
    hook: null,
    instructions: "full",
    budgets: {},
    skill_dir: skillDir,
  };
}

/** asset/get：read 给正文 + 文件清单，readFile 按路径给字节。 */
function assetHub(content = "正文", file = "附件") {
  return hubFetch((action, body) => {
    if (action !== "asset/get") return { code: 404, message: "NOT_FOUND" };
    if (body["path"] !== undefined) {
      return { data: { file: { path: body["path"], encoding: "base64", content: Buffer.from(file, "utf8").toString("base64") } } };
    }
    return { data: { version: { content }, files: [{ path: "refs/x.md", bytes: Buffer.byteLength(file, "utf8") }] } };
  });
}

test("missing hub → UNAVAILABLE, no network call", async () => {
  const hub = assetHub();
  await assert.rejects(
    () => syncSkills({ config: cfg(null, "k"), host: host(), agentId: "ag_1", skills: [SKILL], fetchImpl: hub.fetchImpl }),
    (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
  );
  assert.equal(hub.calls.length, 0);
});

test("missing key → UNAUTHORIZED, no network call", async () => {
  const hub = assetHub();
  await assert.rejects(
    () => syncSkills({ config: cfg("http://h", null), host: host(), agentId: "ag_1", skills: [SKILL], fetchImpl: hub.fetchImpl }),
    (err: unknown) => err instanceof PrepareError && err.code === "UNAUTHORIZED",
  );
  assert.equal(hub.calls.length, 0);
});

test("skill_dir is expanded against home and every asset/get pins the version", () =>
  withHome(async (home) => {
    const hub = assetHub();
    const result = await syncSkills({ config: cfg(), host: host(), agentId: "ag_1", skills: [SKILL], home, fetchImpl: hub.fetchImpl });
    assert.deepEqual(result.written, ["audit"]);
    const root = join(home, ".agents", "skills");
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), "正文");
    assert.equal(readFileSync(join(root, "audit", "refs", "x.md"), "utf8"), "附件");
    assert.equal(hub.calls.length, 2);
    for (const call of hub.calls) {
      assert.equal(call.action, "asset/get");
      assert.equal(call.body["asset_id"], "ast_1");
      assert.equal(call.body["version"], 4, "version must be pinned on every call");
    }
  }));

test("without a home option, ~ in skill_dir is the user home, not the ck state dir", () =>
  withSplitHomes(async ({ userHome, stateHome }) => {
    const hub = assetHub();
    const result = await syncSkills({ config: cfg(), host: host(), agentId: "ag_1", skills: [SKILL], fetchImpl: hub.fetchImpl });
    assert.deepEqual(result.written, ["audit"]);
    const skillFile = join(userHome, ".agents", "skills", "audit", "SKILL.md");
    assert.equal(existsSync(skillFile), true, "SKILL.md must land under the user home");
    assert.equal(readFileSync(skillFile, "utf8"), "正文");
    assert.equal(existsSync(join(stateHome, ".agents")), false, "nothing may be written under the ck state dir");
  }));

test("absolute skill_dir is used as-is", () =>
  withHome(async (home) => {
    const dir = join(home, "custom", "skills");
    const hub = assetHub();
    await syncSkills({ config: cfg(), host: host(dir), agentId: "ag_1", skills: [SKILL], home, fetchImpl: hub.fetchImpl });
    assert.equal(existsSync(join(dir, "audit", "SKILL.md")), true);
  }));

test("hung hub → UNAVAILABLE after the timeout, not a hang", () =>
  withHome(async (home) => {
    const fetchImpl: typeof fetch = () => new Promise<Response>(() => {});
    const started = Date.now();
    await assert.rejects(
      () => syncSkills({ config: cfg(), host: host(), agentId: "ag_1", skills: [SKILL], home, timeoutMs: 20, fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE" && /timed out after 20ms/.test(err.message),
    );
    assert.ok(Date.now() - started < 2000, "must not wait past the deadline");
  }));

test("empty skill list still creates the root and removes nothing", () =>
  withHome(async (home) => {
    const hub = assetHub();
    const result = await syncSkills({ config: cfg(), host: host(), agentId: "ag_1", skills: [], home, fetchImpl: hub.fetchImpl });
    assert.deepEqual(result, { written: [], skipped: [], removed: [] });
    assert.equal(existsSync(join(home, ".agents", "skills")), true);
    assert.equal(hub.calls.length, 0);
  }));

// ---------------------------------------------------------------- ck skills sync

/** Claude Code 的形状：`instructions` 只送 brief，完整文本由 hook 送、按 hook 预算解析。 */
function hookHost(): HostConfig {
  return {
    name: "claude-code",
    title: "test",
    mcp: { file: "", format: "json", key: "mcpServers.ck", insert: false },
    hook: null,
    instructions: "brief",
    budgets: { hook: { budget_chars: 8000 }, tool: { budget_chars: 12000 } },
    skill_dir: "~/.claude/skills",
  };
}

/** dsh 的形状：`instructions` 送完整文本，带字节上限。 */
function fullHost(): HostConfig {
  return { ...host(), budgets: { instructions: { budget_chars: 12000, max_bytes: 24000 } } };
}

/**
 * `ck skills sync` 用到的三个动作。resolve 的短路照真 hub 做（core/src/loadout.ts）：
 * digest 只覆盖文本，`if_digest` 命中时回 `not_modified`，不带 `skills[]`。
 * asset/get 的正文带上被请求的版本号，落盘内容就能看出物化的是哪一版。
 */
function loadoutHub(skills: ResolveSkill[]) {
  const full = resolveData("配装", { skills });
  return hubFetch((action, body) => {
    if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1" } } };
    if (action === "loadout/resolve") {
      return body["if_digest"] === full["digest"] ? { data: { ...full, not_modified: true, text: "", items: [], skills: [] } } : { data: full };
    }
    if (action === "asset/get") return { data: { version: { content: `正文 v${String(body["version"])}` }, files: [] } };
    return { code: 404, message: "NOT_FOUND" };
  });
}

test("runSkillsSync on a brief host with no cache resolves the loadout and materializes its skills", () =>
  withHome(async (home) => {
    const hub = loadoutHub([SKILL]);
    const result = await runSkillsSync({ config: cfg(), host: hookHost(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.deepEqual(result, { agent_id: "ag_1", written: ["audit"], skipped: [], removed: [] });
    assert.equal(readFileSync(join(home, ".claude", "skills", "audit", "SKILL.md"), "utf8"), "正文 v4");
  }));

test("runSkillsSync on a hook-delivered host resolves under the hook budget", () =>
  withHome(async (home) => {
    const hub = loadoutHub([]);
    await runSkillsSync({ config: cfg(), host: hookHost(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.deepEqual(hub.calls[1], { action: "loadout/resolve", body: { agent_id: "ag_1", budget_chars: 8000 }, agent: null });
  }));

test("runSkillsSync skips the digest short-circuit: a new skill version behind an unchanged text is materialized", () =>
  withHome(async (home) => {
    await runSkillsSync({ config: cfg(), host: fullHost(), agent: AGENT, home, fetchImpl: loadoutHub([SKILL]).fetchImpl });
    const skillFile = join(home, ".agents", "skills", "audit", "SKILL.md");
    assert.equal(readFileSync(skillFile, "utf8"), "正文 v4");

    // skill 出了 v5、摘要没变：配装文本与 digest 都和缓存里的一样
    const hub = loadoutHub([{ ...SKILL, version: 5, content_hash: "h5" }]);
    const result = await runSkillsSync({ config: cfg(), host: fullHost(), agent: AGENT, home, fetchImpl: hub.fetchImpl });
    assert.deepEqual(result.written, ["audit"]);
    assert.equal(readFileSync(skillFile, "utf8"), "正文 v5");
    assert.deepEqual(hub.calls[1]!.body, { agent_id: "ag_1", budget_chars: 12000, max_bytes: 24000 });
    const cache = JSON.parse(readFileSync(loadoutCachePath(home, "ag_1"), "utf8")) as { skills: ResolveSkill[] };
    assert.equal(cache.skills[0]!.version, 5, "the cache must carry the fresh list, or the next automatic run goes back to v4");
  }));

test("runSkillsSync with the hub unreachable → UNAVAILABLE instead of syncing from the cached list", () =>
  withHome(async (home) => {
    // 先留下一份清单为空的缓存：旧行为会拿它当真，什么都不做就报成功
    await runSkillsSync({ config: cfg(), host: fullHost(), agent: AGENT, home, fetchImpl: loadoutHub([]).fetchImpl });
    assert.equal(existsSync(loadoutCachePath(home, "ag_1")), true);
    await assert.rejects(
      () => runSkillsSync({ config: cfg(), host: fullHost(), agent: AGENT, home, fetchImpl: hubFetch(() => "network").fetchImpl }),
      (err: unknown) => err instanceof PrepareError && err.code === "UNAVAILABLE",
    );
  }));
