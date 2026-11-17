import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verification } from "@cinlan/knowledge-sdk";
import { VERSION } from "../src/version.js";
import { httpHub, resolveData, type FakeHandler } from "./support.js";

/**
 * 真实进程的退出码。其余测试都在进程内调函数，看不到"进程是怎么结束的"；
 * 这里起真的 `ck`，对着一个真的在监听的假 hub。
 *
 * 要钉住的事：退出码只表达命令的结果。Windows 上 `process.exit()` 紧跟在网络收发之后
 * 会撞 libuv 断言（`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c），进程以
 * 0xC0000409 结束——输出是对的，退出码是错的。Node v24.9.0 实测：连续两次请求、
 * 或一次请求带几 MB 的应答，之后立刻 `process.exit()` 必现；与 `ck` 自己的代码无关。
 */

const CK = fileURLToPath(new URL("../src/bin.js", import.meta.url));
const AGENT = "core/builder";

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

type Ck = (...args: string[]) => Promise<Finished>;
type CkIn = (stdinText: string, ...args: string[]) => Promise<Finished>;

/** 起一个假 hub 和一对临时目录，把 `ck` 子进程关在里面：不读也不写真实的用户目录。 */
async function withCk(handler: FakeHandler, fn: (ck: Ck, userHome: string, ckIn: CkIn) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ck-exit-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const hub = await httpHub(handler);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Windows 的 homedir() 读 USERPROFILE，POSIX 读 HOME：两个都改
    USERPROFILE: userHome,
    HOME: userHome,
    CK_HOME: join(root, "state"),
    CK_HUB_URL: hub.url,
    CK_USER_KEY: "ck_test_key",
  };
  delete env["CK_AGENTS_DIR"];
  delete env["CK_TIMEOUT_MS"];
  const ck: Ck = (...args) =>
    new Promise<Finished>((resolve, reject) => {
      const child = spawn(process.execPath, [CK, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      // 子进程赖着不走也算失败，不让整套测试挂住
      const watchdog = setTimeout(() => child.kill(), 30_000);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });
  const ckIn: CkIn = (stdinText, ...args) =>
    new Promise<Finished>((resolve, reject) => {
      const child = spawn(process.execPath, [CK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      const watchdog = setTimeout(() => child.kill(), 30_000);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
      child.stdin.write(stdinText);
      child.stdin.end();
    });
  try {
    await fn(ck, userHome, ckIn);
  } finally {
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 退出码与 stderr 一起比：崩溃时断言文本在 stderr 里，失败信息里要看得到。 */
function ending(run: Finished): { code: number | null; stderr: string } {
  return { code: run.code, stderr: run.stderr };
}

/** `auth/verify` 的应答，形状钉在 sdk 的 Verification 上。 */
const VERIFY: Verification = {
  user: { id: "usr_1", name: "Yorker", display_name: "Yorker", is_system_admin: false, status: "active", created_at: "2026-01-01T00:00:00.000Z" },
  is_system_admin: false,
  teams: [{ team_id: "tem_1", team: "core", role: "member" }],
  server_version: VERSION,
};

/** 一切正常的 hub：`ck doctor --host` 会依次调这三个动作。 */
const healthy: FakeHandler = (action, body) => {
  if (action === "auth/verify") return { data: VERIFY };
  if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1", name: body["name"], host: body["host"] } } };
  if (action === "loadout/resolve") return { data: resolveData("配装文本") };
  return { code: 404, message: "NOT_FOUND" };
};

/** 像用户那样把宿主接好：`ck setup --write`。 */
async function configureDsh(ck: Ck): Promise<void> {
  const setup = await ck("setup", "--host", "dsh", "--agent", AGENT, "--write");
  assert.deepEqual(ending(setup), { code: 0, stderr: "" }, "arrange: ck setup --write");
}

/** 一切正常的 hub（配装里带一个 inject skill）：`ck hook` 的物化走 asset/get。 */
const healthySkill: FakeHandler = (action, body) => {
  if (action === "auth/verify") return { data: VERIFY };
  if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1", name: body["name"], host: body["host"] } } };
  if (action === "loadout/resolve") {
    return { data: resolveData("配装文本", { skills: [{ asset_id: "ast_s", name: "audit", version: 1, content_hash: "h" }] }) };
  }
  if (action === "asset/get") return { data: { version: { content: "技能正文" }, files: [] } };
  return { code: 404, message: "NOT_FOUND" };
};

test("ck hook session-start: skills are materialized by the hook itself (§5.2)", () =>
  withCk(healthySkill, async (ck, userHome) => {
    const run = await ck("hook", "session-start", "--host", "claude-code", "--agent", AGENT);

    // stdout 只有协议 JSON；退出码 0；skill 已落盘——不用等第二个会话的 ck mcp
    assert.deepEqual(ending(run), { code: 0, stderr: "" });
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(out.hookSpecificOutput.additionalContext, /配装文本/);
    assert.equal(readFileSync(join(userHome, ".claude", "skills", "audit", "SKILL.md"), "utf8"), "技能正文");
    assert.equal(existsSync(join(userHome, ".claude", "skills", "audit", ".cinlan-knowledge.json")), true);
  }));

test("ck setup dry-run prints the ck-managed content, not the whole file (§5.1)", () =>
  withCk(healthy, async (ck, userHome) => {
    // 既有文件里带着别人的内容（settings.json 里有 token 的场景）：dry-run 只能打印 ck 管的那段
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ numStartups: 42, mcpServers: {} }, null, 2));

    const run = await ck("setup", "--host", "claude-code", "--agent", AGENT);

    assert.deepEqual(ending(run), { code: 0, stderr: "" });
    assert.match(run.stdout, /update    .*\.claude\.json/);
    assert.match(run.stdout, /mcpServers\.ck:/);
    assert.match(run.stdout, /hooks\.SessionStart: \[ …,/);
    assert.match(run.stdout, /dry run: re-run with --write to apply/);
    assert.doesNotMatch(run.stdout, /numStartups/, "other people's keys must not be echoed");
    assert.equal(existsSync(join(userHome, ".claude", "settings.json")), false, "dry run writes nothing");
  }));

test("ck setup --host generic (and the generic-mcp alias) prints manual snippets and exits 0 (§5.11)", () =>
  withCk(healthy, async (ck) => {
    for (const host of ["generic", "generic-mcp"]) {
      const run = await ck("setup", "--host", host, "--agent", AGENT);
      assert.deepEqual(ending(run), { code: 0, stderr: "" }, host);
      assert.match(run.stdout, /stdio/, host);
      assert.match(run.stdout, /"mcpServers"/, host);
      assert.match(run.stdout, /"--agent",\s+"core\/builder"/, host);
      assert.match(run.stdout, /http:\/\/127\.0\.0\.1:\d+\/mcp/, host);
      assert.match(run.stdout, /x-ck-agent/, host);
    }
  }));

test("ck doctor --host: every check ok → exits 0, nothing on stderr", () =>
  withCk(healthy, async (ck, userHome) => {
    await configureDsh(ck);
    mkdirSync(join(userHome, ".agents", "skills"), { recursive: true });

    const run = await ck("doctor", "--host", "dsh");

    const checks = (JSON.parse(run.stdout) as { checks: Record<string, { ok: boolean }> }).checks;
    assert.deepEqual(
      Object.entries(checks).map(([name, check]) => [name, check.ok]),
      [
        ["config", true],
        ["hub", true],
        ["key", true],
        ["version", true],
        ["host_config", true],
        ["skill_dir", true],
        ["agent", true],
        ["resolve", true],
        ["cache", true],
      ],
    );
    assert.deepEqual(ending(run), { code: 0, stderr: "" });
  }));

test("ck doctor --host: a failing check → exits 1", () =>
  withCk(healthy, async (ck, userHome) => {
    // ~/.agents 落成文件：skill 目录建不出来（§5.5 判据「父目录可创建」不成立），其余检查照跑
    await configureDsh(ck);
    writeFileSync(join(userHome, ".agents"), "not a directory");

    const run = await ck("doctor", "--host", "dsh");

    const checks = (JSON.parse(run.stdout) as { checks: Record<string, { ok: boolean }> }).checks;
    assert.equal(checks["skill_dir"]!.ok, false);
    assert.equal(checks["resolve"]!.ok, true);
    assert.deepEqual(ending(run), { code: 1, stderr: "" });
  }));

test("ck setup --write: a conflict in one file → nothing is written anywhere, exits 1", () =>
  withCk(healthy, async (ck, userHome) => {
    // 结构性冲突（§5.9 后同名条目是原地更新不再报冲突）：.claude.json 不是合法 JSON
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    writeFileSync(join(userHome, ".claude.json"), "{ not json");

    const run = await ck("setup", "--host", "claude-code", "--agent", AGENT, "--write");

    assert.deepEqual(ending(run), { code: 1, stderr: "" });
    const lines = run.stdout.trimEnd().split("\n");
    assert.equal(lines[0], `conflict  ${join(userHome, ".claude.json")}`);
    assert.equal(lines.at(-2), `create    ${join(userHome, ".claude", "settings.json")}`);
    assert.equal(lines.at(-1), "nothing written: resolve the conflict(s) above, then re-run");
    assert.equal(existsSync(join(userHome, ".claude", "settings.json")), false);
    assert.equal(readFileSync(join(userHome, ".claude.json"), "utf8"), "{ not json");
  }));

test("ck skills sync: a failure after the hub was reached → error JSON on stdout, exits 1", () =>
  withCk(
    (action, body) => (action === "loadout/resolve" ? { code: 500, message: "INTERNAL" } : healthy(action, body)),
    async (ck) => {
      const run = await ck("skills", "sync", "--host", "dsh", "--agent", AGENT);

      const out = JSON.parse(run.stdout) as { ok: boolean; code: string };
      assert.equal(out.ok, false);
      assert.equal(out.code, "INTERNAL");
      assert.deepEqual(ending(run), { code: 1, stderr: "" });
    },
  ));

test("ck rpc: a multi-megabyte response → the whole envelope on stdout, exits 0", () => {
  const pad = "x".repeat(4 * 1024 * 1024);
  return withCk(
    () => ({ data: { pad } }),
    async (ck) => {
      const run = await ck("rpc", "asset/get", "{}");

      assert.deepEqual(ending(run), { code: 0, stderr: "" });
      const envelope = JSON.parse(run.stdout) as { code: number; data: { pad: string } };
      assert.equal(envelope.code, 0);
      assert.equal(envelope.data.pad.length, pad.length);
    },
  );
});

test("ck rpc: an error envelope → printed as is, exits 1", () =>
  withCk(
    () => ({ code: 404, message: "NOT_FOUND" }),
    async (ck) => {
      const run = await ck("rpc", "asset/get", "{}");

      const envelope = JSON.parse(run.stdout) as { code: number; message: string };
      assert.equal(envelope.code, 404);
      assert.equal(envelope.message, "NOT_FOUND");
      assert.deepEqual(ending(run), { code: 1, stderr: "" });
    },
  ));

/** 在 claude-code 的扫描位置（`~/.claude/skills`）放一个本地 skill。 */
function localSkill(userHome: string, name: string): void {
  const dir = join(userHome, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: local ${name}\n---\nbody\n`);
}

test("ck import: per-item results and the summary on stdout; a failed item → exits 1, none → exits 0", () => {
  let rejectTwo = true;
  return withCk(
    (action, body) => {
      if (action !== "asset/import") return healthy(action, body);
      if (rejectTwo && body["name"] === "s-two") return { code: 403, message: "FORBIDDEN" };
      return { data: { status: "created", asset: {} } };
    },
    async (ck, userHome) => {
      localSkill(userHome, "s-one");
      localSkill(userHome, "s-two");

      const failed = await ck("import", "--source", "claude-code", "--workspace", userHome, "--yes");
      assert.equal(
        failed.stdout,
        ["import → team core", "  ok    s-one (created)", "  fail  s-two (FORBIDDEN)", "total 2 · success 1 · failed 1 · skipped 0", ""].join("\n"),
      );
      assert.deepEqual(ending(failed), { code: 1, stderr: "" });

      rejectTwo = false;
      const clean = await ck("import", "--source", "claude-code", "--workspace", userHome, "--yes");
      assert.match(clean.stdout, /total 2 · success 2 · failed 0 · skipped 0/);
      assert.deepEqual(ending(clean), { code: 0, stderr: "" });
    },
  );
});

test("ck import: refused right after auth/verify → one line on stderr, exits 1", () => {
  let reply: "two-teams" | "bad-key" = "two-teams";
  return withCk(
    (action, body) => {
      if (action !== "auth/verify") return healthy(action, body);
      if (reply === "bad-key") return { code: 401, message: "UNAUTHORIZED", data: { detail: "key shape" } };
      return { data: { ...VERIFY, teams: [...VERIFY.teams, { team_id: "tem_2", team: "ops", role: "member" }] } };
    },
    async (ck, userHome) => {
      localSkill(userHome, "s-one");

      const ambiguous = await ck("import", "--source", "claude-code", "--workspace", userHome, "--yes");
      assert.deepEqual(ending(ambiguous), {
        code: 1,
        stderr: "ck import: 你属于多个团队（core, ops）；用 --team <slug> 指定导入到哪个团队\n",
      });

      reply = "bad-key";
      const unauthorized = await ck("import", "--source", "claude-code", "--workspace", userHome, "--yes");
      assert.deepEqual(ending(unauthorized), { code: 1, stderr: "ck import: UNAUTHORIZED: key shape\n" });
    },
  );
});

test("ck hook: a host ck does not know → exits 0, stdout is the loadout.md §3 error block", () =>
  withCk(healthy, async (ck) => {
    // 读档还没开始就失败（宿主声明找不到）：对宿主来说仍是"读档失败"，形状与其余失败同一个
    const run = await ck("hook", "session-start", "--host", "nope", "--agent", AGENT);

    assert.deepEqual(ending(run), { code: 0, stderr: "" });
    assert.deepEqual(JSON.parse(run.stdout), {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          '<cinlan_knowledge error="INTERNAL">\n团队记忆中枢本次读档失败：INTERNAL。团队配装未加载；调用 knowledge_status 查看原因。\n</cinlan_knowledge>',
      },
    });
  }));

test("ck hook pre-llm-call: hermes stdin 门控——BOM 前缀不误判首轮，非首轮输出 {}", () =>
  withCk(healthy, async (_ck, _userHome, ckIn) => {
    // PowerShell 给管道 stdin 加 BOM：不 trim 的话 JSON.parse 抛错 → 首轮永远被门掉（2026-11-13 实机验收踩到）
    const first = await ckIn('\uFEFF{"extra":{"is_first_turn":true}}', "hook", "pre-llm-call", "--host", "hermes", "--agent", AGENT);
    assert.deepEqual(ending(first), { code: 0, stderr: "" });
    const injected = JSON.parse(first.stdout) as { context?: string };
    assert.ok(typeof injected.context === "string" && injected.context.includes("配装文本"), first.stdout);

    const later = await ckIn('{"extra":{"is_first_turn":false}}', "hook", "pre-llm-call", "--host", "hermes", "--agent", AGENT);
    assert.deepEqual(ending(later), { code: 0, stderr: "" });
    assert.equal(later.stdout.trim(), "{}");

    const junk = await ckIn("not-json", "hook", "pre-llm-call", "--host", "hermes", "--agent", AGENT);
    assert.deepEqual(ending(junk), { code: 0, stderr: "" });
    assert.equal(junk.stdout.trim(), "{}");
  }));
