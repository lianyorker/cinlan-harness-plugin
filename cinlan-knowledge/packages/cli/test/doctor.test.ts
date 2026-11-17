import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verification } from "@cinlan/knowledge-sdk";
import { runDoctor } from "../src/doctor.js";
import type { ResolvedConfig } from "../src/config.js";
import { hostConfig } from "../src/hosts.js";
import { expandHome } from "../src/paths.js";
import { applyPlan, planSetup } from "../src/setup.js";
import { hubFetch, withSplitHomes } from "./support.js";

/**
 * `ck doctor`（hosts.md §5）：每项各自成败，不因一项失败跳过其余；
 * key 只报 present/missing；`--host` 从宿主配置读 Agent 名，JSON 与 YAML 块两种都要认。
 * install.md §5 的四件宿主侧检查：条目存在、指向本机 ck（`points_to_self`）、hook 条目（codex 连信任表）、skill 目录可写。
 */

/** 测试里固定的 ck 入口：setup 与 doctor 的 `ckEntry` 都用它，`points_to_self` 才有共同的比较对象。 */
const CK_ENTRY = "/abs/ck/bin.js";

function cfg(hub: string | null = "http://hub:8424", key: string | null = "ck_k"): ResolvedConfig {
  return { hub, key, sources: { hub: "env", key: "env" } };
}

function withHome(fn: (home: string) => Promise<void> | void): Promise<void> | void {
  const home = mkdtempSync(join(tmpdir(), "ck-doctor-"));
  const done = (): void => rmSync(home, { recursive: true, force: true });
  try {
    const maybe = fn(home);
    return maybe instanceof Promise ? maybe.finally(done) : done();
  } catch (err) {
    done();
    throw err;
  }
}

/** 像 `ck setup --write` 那样把宿主接好（stdio），skill 目录建好由各用例自行决定。 */
function setupHost(home: string, hostName: string, env: NodeJS.ProcessEnv = {}): void {
  const host = hostConfig(hostName);
  applyPlan(
    planSetup({ host, agent: { team: "core", name: "builder" }, transport: "stdio", ckEntry: CK_ENTRY, rules: false, home, env }),
  );
}

/** `auth/verify` 的应答。形状钉在 sdk 的 Verification 上：假 hub 不自己发明字段名。 */
const VERIFY: Verification = {
  user: { id: "usr_1", name: "Yorker", display_name: "Yorker", is_system_admin: false, status: "active", created_at: "2026-01-01T00:00:00.000Z" },
  is_system_admin: false,
  teams: [{ team_id: "tem_1", team: "core", role: "member" }],
  server_version: "0.1.0",
};

/** auth/verify + agent/ensure + loadout/resolve 的正常应答。 */
function healthyHub() {
  return hubFetch((action, body) => {
    if (action === "auth/verify") return { data: VERIFY };
    if (action === "agent/ensure") return { data: { agent: { id: "ag_1", name: body["name"], host: body["host"] } } };
    if (action === "loadout/resolve") {
      return {
        data: {
          digest: "d1",
          chars: 10,
          bytes: 10,
          items: [{ asset_id: "ast_1", version: 1 }],
          skills: [{ name: "audit" }],
          skipped: [],
          text: "",
          not_modified: false,
          downgraded: 0,
          generated_at: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
}

type Checks = Record<string, { ok: boolean; detail?: unknown }>;

function checksOf(result: Record<string, unknown>): Checks {
  return result["checks"] as Checks;
}

test("missing config → config/hub not ok, key never echoed", async () => {
  const { result, ok } = await runDoctor({ config: cfg(null, "ck_secret_value"), fetchImpl: hubFetch(() => ({ data: {} })).fetchImpl, home: "/nonexistent-home" });
  const checks = checksOf(result);
  assert.equal(ok, false);
  assert.equal(checks["config"]!.ok, false);
  assert.equal(checks["hub"]!.ok, false);
  const dump = JSON.stringify(result);
  assert.ok(!dump.includes("ck_secret_value"), "raw key must never appear in doctor output");
  assert.ok(dump.includes('"present"'));
});

test("hub down → hub not ok, version skipped gracefully", async () => {
  const { result, ok } = await runDoctor({ config: cfg(), fetchImpl: hubFetch(() => "network").fetchImpl, home: "/tmp" });
  const checks = checksOf(result);
  assert.equal(ok, false);
  assert.equal(checks["hub"]!.ok, false);
  assert.equal(checks["key"]!.ok, false);
});

test("healthy hub, no --host → config/hub/key/version ok", async () => {
  const { result, ok } = await runDoctor({ config: cfg(), fetchImpl: healthyHub().fetchImpl, home: "/tmp" });
  const checks = checksOf(result);
  assert.equal(ok, true);
  const detail = checks["key"]!.detail as { user?: string; teams?: string[] };
  assert.equal(detail.user, "Yorker");
  assert.deepEqual(detail.teams, ["core"]);
  const version = checks["version"]!.detail as { ck: string; hub: string; same: boolean };
  assert.equal(version.same, true);
});

test("claude-code: agent parsed from mcpServers.ck args, ensure + resolve run", () =>
  withHome(async (home) => {
    setupHost(home, "claude-code");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const hub = healthyHub();
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: hub.fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal(ok, true);
    assert.deepEqual(checks["host_config"]!.detail, {
      file: join(home, ".claude.json"),
      exists: true,
      agent: "core/builder",
      points_to_self: true,
      hint: undefined,
    });
    // undefined 字段被 JSON 化前是 undefined；detail 里 hint 就应该是 undefined
    assert.equal(checks["host_config"]!.detail && (checks["host_config"]!.detail as { hint?: unknown }).hint, undefined);
    const hook = checks["hook"]!.detail as HookDetail;
    assert.equal(hook.hook_present, true);
    assert.equal((checks["agent"]!.detail as { team_visible?: boolean }).team_visible, true);
    const resolved = checks["resolve"]!.detail as { digest?: string; items?: number; skills?: string[] };
    assert.equal(resolved.digest, "d1");
    assert.equal(resolved.items, 1);
    assert.deepEqual(resolved.skills, ["audit"]);
    assert.deepEqual(hub.calls.map((c) => c.action), ["auth/verify", "agent/ensure", "loadout/resolve"]);
    // F11（§6.2）：claude-code 只声明 hook 预算（8,000），探针要按宿主声明的预算量，不是 hub 默认。
    const resolveCall = hub.calls.find((c) => c.action === "loadout/resolve")!;
    assert.equal((resolveCall.body as { budget_chars?: number }).budget_chars, 8000);
  }));

test("host config file missing → exists false with the same hint (§6.3)", () =>
  withHome(async (home) => {
    const hub = healthyHub();
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: hub.fetchImpl });
    const checks = checksOf(result);
    assert.equal(ok, false);
    assert.equal(checks["host_config"]!.ok, false);
    const detail = checks["host_config"]!.detail as { exists?: boolean; hint?: string };
    assert.equal(detail.exists, false);
    assert.equal(detail.hint, "run `ck setup --write` for this host");
  }));

test("MCP entry pointing to another ck install → host_config not ok (points_to_self false)", () =>
  withHome(async (home) => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { ck: { command: "node", args: ["D:/elsewhere/bin.js", "mcp", "--host", "claude-code", "--agent", "core/builder"] } } }),
    );
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal(ok, false);
    assert.equal(checks["host_config"]!.ok, false);
    assert.equal((checks["host_config"]!.detail as { points_to_self?: boolean }).points_to_self, false);
  }));

test("hook entry absent → hook check fails on json hosts (install.md §5: hook 条目存在)", () =>
  withHome(async (home) => {
    setupHost(home, "claude-code");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    rmSync(join(home, ".claude", "settings.json"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: {} }));
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal(ok, false);
    const hook = checks["hook"]!;
    assert.equal(hook.ok, false);
    assert.equal((hook.detail as HookDetail).hook_present, false);
  }));

test("dsh: agent parsed only from inside the marked YAML block", () =>
  withHome(async (home) => {
    mkdirSync(join(home, ".dsh"), { recursive: true });
    writeFileSync(
      join(home, ".dsh", "cordis.patch.yml"),
      [
        "insert:",
        "  - name: someone-elses-plugin",
        "    config:",
        "      args: ['--agent', 'other/thing']",
        "# >>> cinlan-knowledge (managed by ck; do not edit)",
        "  - name: '@deepseek-ai/dsh-mcp-client'",
        "    config:",
        "      command: node",
        "      args: ['/abs/ck/bin.js', 'mcp', '--host', 'dsh', '--agent', 'core/builder']",
        "# <<< cinlan-knowledge",
        "",
      ].join("\n"),
    );
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    const { result } = await runDoctor({ config: cfg(), host: "dsh", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal((checks["host_config"]!.detail as { agent?: string }).agent, "core/builder");
    assert.equal((checks["host_config"]!.detail as { points_to_self?: boolean }).points_to_self, true);
  }));

test("codex: full setup → hook ok; hooks.json 的命令被改动后 trusted_hash 对不上 → hook not ok", () =>
  withHome(async (home) => {
    setupHost(home, "codex");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    const { result, ok } = await runDoctor({ config: cfg(), host: "codex", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal((checks["host_config"]!.detail as { agent?: string }).agent, "core/builder");
    assert.equal((checks["host_config"]!.detail as { points_to_self?: boolean }).points_to_self, true);
    let hook = checks["hook"]!.detail as HookDetail;
    assert.equal(hook.hook_present, true);
    assert.equal(hook.trust_entry_present, true);
    assert.equal(hook.trust_enabled, true);
    assert.equal(hook.trusted_hash_matches, true);
    assert.equal(ok, true);

    // 改 hooks.json 里我们的命令：条目还在（含 hook session-start），但信任哈希是按旧命令算的
    const hooksFile = join(home, ".codex", "hooks.json");
    const doc = JSON.parse(readFileSync(hooksFile, "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    doc.hooks.SessionStart[0]!.hooks[0]!.command = `node "${CK_ENTRY}" hook session-start --host codex --agent core/other`;
    writeFileSync(hooksFile, JSON.stringify(doc, null, 2));
    const tampered = await runDoctor({ config: cfg(), host: "codex", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    hook = checksOf(tampered.result)["hook"]!.detail as HookDetail;
    assert.equal(hook.hook_present, true);
    assert.equal(hook.trusted_hash_matches, false);
    assert.equal(checksOf(tampered.result)["hook"]!.ok, false);
    assert.equal(tampered.ok, false);
  }));

test("gemini-cli: agent parsed from mcpServers.ck args in settings.json, hook entry checked", () =>
  withHome(async (home) => {
    setupHost(home, "gemini-cli");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    const { result, ok } = await runDoctor({ config: cfg(), host: "gemini-cli", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal((checks["host_config"]!.detail as { agent?: string }).agent, "core/builder");
    assert.equal((checks["hook"]!.detail as HookDetail).hook_present, true);
    assert.equal(ok, true);
  }));

/** `ck setup --write` 写一遍 hermes（POSIX `~/.hermes`，win32 `%LOCALAPPDATA%/hermes`），返回 env 与 allowlist 路径。 */
function hermesSetup(home: string): { env: NodeJS.ProcessEnv; consent: string } {
  const env = { LOCALAPPDATA: join(home, "localappdata") };
  const host = hostConfig("hermes");
  applyPlan(
    planSetup({ host, agent: { team: "core", name: "builder" }, transport: "stdio", ckEntry: CK_ENTRY, rules: false, home, env }),
  );
  mkdirSync(expandHome(host.skill_dir, home, env), { recursive: true });
  return { env, consent: expandHome(host.hook!.consent!.file, home, env) };
}

type HookDetail = {
  hook_present?: boolean;
  approved?: boolean;
  trust_entry_present?: boolean;
  trust_enabled?: boolean | null;
  trusted_hash_matches?: boolean | null;
};

test("hermes: ck setup 写出的 hook + allowlist → hook ok", () =>
  withHome(async (home) => {
    const { env } = hermesSetup(home);
    const { result, ok } = await runDoctor({ config: cfg(), host: "hermes", home, env, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal((checks["host_config"]!.detail as { agent?: string }).agent, "core/builder");
    const hook = checks["hook"]!.detail as HookDetail;
    assert.equal(hook.hook_present, true);
    assert.equal(hook.approved, true);
    assert.equal(ok, true);
  }));

test("hermes: allowlist 批的不是 config.yaml 里那条命令 → approved false（hermes 按 (event, command) 精确匹配）", () =>
  withHome(async (home) => {
    const { env, consent } = hermesSetup(home);
    writeFileSync(
      consent,
      JSON.stringify({
        approvals: [{ event: "pre_llm_call", command: 'node "/abs/ck/bin.js" hook pre-llm-call --host hermes --agent core/other' }],
      }),
    );
    const { result, ok } = await runDoctor({ config: cfg(), host: "hermes", home, env, fetchImpl: healthyHub().fetchImpl });
    const hook = checksOf(result)["hook"]!;
    assert.equal(hook.ok, false);
    assert.equal((hook.detail as HookDetail).hook_present, true);
    assert.equal((hook.detail as HookDetail).approved, false);
    assert.equal(ok, false);
  }));

test("hermes: allowlist 是顶层列表 → approved false（hermes 按不可读处理，hook 不注册）", () =>
  withHome(async (home) => {
    const { env, consent } = hermesSetup(home);
    writeFileSync(
      consent,
      JSON.stringify([{ event: "pre_llm_call", command: 'node "/abs/ck/bin.js" hook pre-llm-call --host hermes --agent core/builder' }]),
    );
    const { result } = await runDoctor({ config: cfg(), host: "hermes", home, env, fetchImpl: healthyHub().fetchImpl });
    const hook = checksOf(result)["hook"]!;
    assert.equal(hook.ok, false);
    assert.equal((hook.detail as HookDetail).approved, false);
  }));

test("host config present but ck entry absent → hint to run setup, agent check skipped", () =>
  withHome(async (home) => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const hub = healthyHub();
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: hub.fetchImpl });
    const checks = checksOf(result);
    assert.equal(ok, false);
    assert.equal(checks["host_config"]!.ok, false);
    assert.equal((checks["host_config"]!.detail as { hint?: string }).hint, "run `ck setup --write` for this host");
    assert.equal(checks["agent"], undefined);
    assert.deepEqual(hub.calls.map((c) => c.action), ["auth/verify"]);
  }));

test("missing skill dir with a creatable parent → ok（§5.5 取 A：存在且可写，或父目录可创建）", () =>
  withHome(async (home) => {
    setupHost(home, "claude-code");
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal(checks["skill_dir"]!.ok, true);
    const detail = checks["skill_dir"]!.detail as { exists?: boolean; writable?: boolean };
    assert.equal(detail.exists, false);
    assert.equal(detail.writable, true);
    assert.equal(ok, true);
  }));

test("skill dir blocked by a file ancestor → not ok", () =>
  withHome(async (home) => {
    setupHost(home, "dsh");
    // ~/.agents 是文件：物化时 mkdir 进不去，判据的「父目录可创建」不成立
    writeFileSync(join(home, ".agents"), "not a directory");
    const { result, ok } = await runDoctor({ config: cfg(), host: "dsh", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal(checks["skill_dir"]!.ok, false);
    assert.equal((checks["skill_dir"]!.detail as { exists?: boolean }).exists, false);
    assert.equal((checks["skill_dir"]!.detail as { writable?: boolean }).writable, false);
    assert.equal(ok, false);
  }));

test("cache check is informational: missing dir → entries null, existing dir → file count, always ok", () =>
  withHome(async (home) => {
    setupHost(home, "dsh");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    const absent = await runDoctor({ config: cfg(), host: "dsh", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const cache = checksOf(absent.result)["cache"]!;
    assert.equal(cache.ok, true);
    assert.equal((cache.detail as { path: string }).path, join(home, "cache"));
    assert.equal((cache.detail as { entries: number | null }).entries, null);

    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", "loadout-ag_1.json"), "{}");
    writeFileSync(join(home, "cache", "agent-core-builder.json"), "{}");
    const present = await runDoctor({ config: cfg(), host: "dsh", home, fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const cache2 = checksOf(present.result)["cache"]!;
    assert.equal(cache2.ok, true);
    assert.equal((cache2.detail as { entries: number | null }).entries, 2);
  }));

test("without a home option, host files are looked up under the user home; result.home is the ck state dir", () =>
  withSplitHomes(async ({ userHome, stateHome }) => {
    setupHost(userHome, "claude-code");
    mkdirSync(join(userHome, ".claude", "skills"), { recursive: true });
    const { result, ok } = await runDoctor({ config: cfg(), host: "claude-code", fetchImpl: healthyHub().fetchImpl, ckEntry: CK_ENTRY });
    const checks = checksOf(result);
    assert.equal((checks["host_config"]!.detail as { file?: string }).file, join(userHome, ".claude.json"));
    assert.equal((checks["host_config"]!.detail as { agent?: string }).agent, "core/builder");
    assert.deepEqual(checks["skill_dir"], {
      ok: true,
      detail: { path: join(userHome, ".claude", "skills"), exists: true, writable: true },
    });
    assert.equal((checks["cache"]!.detail as { path: string }).path, join(stateHome, "cache"));
    assert.equal(result["home"], stateHome, "the reported home is the ck state dir");
    assert.equal(ok, true);
  }));

test("unknown host → explicit error listing known hosts", () =>
  withHome(async (home) => {
    const { result, ok } = await runDoctor({ config: cfg(), host: "nope", home, fetchImpl: healthyHub().fetchImpl });
    const checks = checksOf(result);
    assert.equal(ok, false);
    assert.ok(((checks["host_config"]!.detail as { message?: string }).message ?? "").includes("nope"));
    assert.ok(Array.isArray((checks["host_config"]!.detail as { known?: unknown }).known));
  }));

test("agent/ensure failure lands on the agent check, resolve skipped", () =>
  withHome(async (home) => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { ck: { args: ["mcp", "--host", "claude-code", "--agent", "core/builder"] } } }),
    );
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const hub = hubFetch((action) => {
      if (action === "auth/verify") return { data: VERIFY };
      if (action === "agent/ensure") return { code: 403, message: "FORBIDDEN" };
      return { code: 404, message: "NOT_FOUND" };
    });
    const { result } = await runDoctor({ config: cfg(), host: "claude-code", home, fetchImpl: hub.fetchImpl });
    const checks = checksOf(result);
    assert.equal(checks["agent"]!.ok, false);
    assert.equal((checks["agent"]!.detail as { code?: string }).code, "FORBIDDEN");
    assert.equal(checks["resolve"], undefined);
  }));
