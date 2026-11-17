import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioFace, errorInstructions, KnowledgeRpcError } from "@cinlan/knowledge-mcp";
import { ckHome, resolveConfig, type ResolvedConfig } from "./config.js";
import { logEvent } from "./log.js";
import { rpc, RpcError } from "./rpc.js";
import { runDoctor } from "./doctor.js";
import { hookEventCli, hostConfig, knownHosts, type HostConfig } from "./hosts.js";
import { runHook, wrapHookContext } from "./hook.js";
import { runImport } from "./import.js";
import { runEmbeddingsSync } from "./embeddings.js";
import { runReflect, runReflectTeam } from "./reflect.js";
import { createCliSession } from "./mcp.js";
import { PrepareError, parseAgent, type PreparedLoadout } from "./prepare.js";
import { applyPlan, planSetup, type SetupPlan } from "./setup.js";
import { runSkillsSync, syncSkills } from "./sync.js";
import { VERSION } from "./version.js";

const USAGE = `usage:
  ck login --hub <url> [--no-verify]                     # read key from stdin, save to ~/.cinlan-knowledge/
  ck setup --host <h> --agent <team>/<name> [--transport stdio|http] [--rules] [--write]
  ck mcp --host <h> --agent <team>/<name> [--baseline brief|full]
  ck hook <event> --host <h> --agent <team>/<name>       # event: session-start | pre-llm-call（按宿主声明）
  ck skills sync --host <h> --agent <team>/<name>
  ck doctor [--host <h>]
  ck rpc <action> [json]                                 # e.g. ck rpc auth/verify '{}'
  ck import --source <h> [--team <slug>] [--workspace <dir>] [--yes] [--update] [--dry-run]
  ck embeddings sync --url <base> --model <m> [--api-key <k>] [--team <slug>] [--limit <n>] [--dry-run]
  ck reflect --asset <id> --url <base> --model <m> [--api-key <k>] [--team <slug>] [--dry-run]
  ck reflect --team <slug> --url <base> --model <m> [--api-key <k>] [--limit <n>] [--dry-run]
  ck --version

hosts: ${knownHosts().join(", ")}
env: CK_HUB_URL, CK_USER_KEY, CK_HOME, CK_AGENTS_DIR, CK_TIMEOUT_MS, CK_EMBED_URL, CK_EMBED_MODEL, CK_EMBED_KEY, CK_LLM_URL, CK_LLM_MODEL, CK_LLM_KEY`;

const NOT_YET: string[] = [];

function die(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function requireFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (value === undefined || value === "") die(`${name} is required (see \`ck --help\`)`);
  return value;
}

function requireConfig(): ResolvedConfig & { hub: string; key: string } {
  const cfg = resolveConfig();
  if (!cfg.hub) die("hub url not configured: set CK_HUB_URL or run `ck login --hub <url>`");
  if (!cfg.key) die("user key not configured: set CK_USER_KEY or run `ck login --hub <url>`");
  return cfg as ResolvedConfig & { hub: string; key: string };
}

/** `CK_TIMEOUT_MS` 只调 prepare 的 2–3 步；解析不了按缺省 3s，不静默改大。 */
function timeoutMs(): number | undefined {
  const raw = process.env.CK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** 本进程的 `ck` 入口绝对路径：写进宿主配置命令，不依赖 PATH。统一正斜杠（install.md §5：
 * Windows 上也写 `D:/…`——cmd / PowerShell / Git Bash 都接受，双引号里不会被当转义）。 */
function ckEntry(): string {
  return fileURLToPath(import.meta.url).replace(/\\/g, "/");
}

// ------------------------------------------------------------------ 子命令
//
// 收发过网络应答的出口一律不调 process.exit()：应答刚收完就强退，Windows 上会撞 libuv 断言、
// 以 0xC0000409 退出，退出码就不再是命令的结果（test/exit.test.ts）。
// 设好 process.exitCode，让事件循环自然排空。

async function cmdRpc(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action) die(USAGE);
  const { hub, key } = requireConfig();
  let body: Record<string, unknown> = {};
  if (argv[1] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(argv[1]);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        die("body must be a JSON object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      die("body is not valid JSON");
    }
  }
  try {
    const env = await rpc({ hub, key, action, body });
    process.stdout.write(JSON.stringify(env, null, 2) + "\n");
    process.exitCode = env.code === 0 ? 0 : 1;
  } catch (err) {
    if (err instanceof RpcError) die(err.message);
    throw err;
  }
}

async function cmdLogin(argv: string[]): Promise<void> {
  const hub = (flag(argv, "--hub") ?? resolveConfig().hub)?.replace(/\/+$/, "");
  if (!hub) die("login requires --hub <url>");
  const key = (await readStdin()).trim();
  if (key === "") die("no key on stdin");
  if (!has(argv, "--no-verify")) {
    let env;
    try {
      env = await rpc({ hub, key, action: "auth/verify", body: {} });
    } catch (err) {
      if (err instanceof RpcError) die(`${err.message} (use --no-verify to save the key anyway)`);
      throw err;
    }
    if (env.code !== 0) die(`key rejected: ${env.message}`);
  }

  const home = ckHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ hub }, null, 2) + "\n");
  const keyFile = join(home, "key");
  writeFileSync(keyFile, key + "\n", { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // Windows 无 POSIX 权限位；依赖用户目录 ACL
  }
  process.stdout.write(JSON.stringify({ ok: true, hub, home, verified: !has(argv, "--no-verify") }) + "\n");
}

/** generic 宿主的手工接入片段（install.md §5「其他宿主」）：没有可写的配置文件，打印后人工抄。 */
function printGenericSnippets(host: HostConfig, agent: string, hub: string | null): void {
  const hubUrl = hub !== null && hub !== "" ? hub : "<hub-host>:8424";
  process.stdout.write(
    [
      `host ${host.name} declares no config file; print manual snippets instead (exit 0).`,
      "",
      "stdio（本机有 Node 与 ck 时优先；key 不进宿主配置）——在宿主的 MCP 配置里加一条（外层 key 名按宿主习惯调整）:",
      JSON.stringify(
        { mcpServers: { ck: { command: "node", args: [ckEntry(), "mcp", "--host", host.name, "--agent", agent] } } },
        null,
        2,
      ),
      "",
      "http（A0，宿主装不了 Node / ck；key 在宿主侧注入，仅内网用）:",
      JSON.stringify(
        {
          mcpServers: {
            ck: {
              type: "http",
              url: `${hubUrl.replace(/\/+$/, "")}/mcp`,
              headers: { Authorization: "Bearer $CK_USER_KEY", "x-ck-agent": agent, "x-ck-host": host.name },
            },
          },
        },
        null,
        2,
      ),
      "",
    ].join("\n") + "\n",
  );
}

async function cmdSetup(argv: string[]): Promise<void> {
  const hostName = requireFlag(argv, "--host");
  const agentValue = requireFlag(argv, "--agent");
  const transport = flag(argv, "--transport") ?? "stdio";
  if (transport !== "stdio" && transport !== "http") die("--transport must be stdio or http");
  let host: HostConfig;
  let agent;
  try {
    host = hostConfig(hostName);
    agent = parseAgent(agentValue);
  } catch (err) {
    die(`ck setup: ${(err as Error).message}`);
  }
  // generic 及同形宿主（声明里没有配置文件与 hook）：没有可写的东西，打印手工片段（install.md §5）
  if (host.mcp.file === "" && host.hook === null) {
    printGenericSnippets(host, agentValue, resolveConfig().hub);
    process.exitCode = 0;
    return;
  }

  let plan: SetupPlan;
  try {
    plan = planSetup({
      host,
      agent,
      transport,
      ckEntry: ckEntry(),
      hubUrl: resolveConfig().hub,
      rules: has(argv, "--rules"),
    });
  } catch (err) {
    die(`ck setup: ${(err as Error).message}`);
  }

  const write = has(argv, "--write");
  const indented = (text: string): string => `${text.split("\n").map((l) => `          ${l}`).join("\n")}\n`;
  for (const change of plan.changes) {
    process.stdout.write(`${change.status.padEnd(9)} ${change.file}\n`);
    if (change.detail !== undefined) process.stdout.write(indented(change.detail));
    // dry-run 打印 ck 管的那段（§5.1）；--write 已落盘，不重复打印
    if (!write && change.preview !== undefined) process.stdout.write(indented(change.preview));
  }
  if (write && plan.changes.some((c) => c.status === "conflict")) {
    process.stdout.write("nothing written: resolve the conflict(s) above, then re-run\n");
  } else if (write) {
    const written = applyPlan(plan);
    process.stdout.write(written.length > 0 ? `wrote ${written.length} file(s)\n` : "nothing to write\n");
  } else {
    process.stdout.write("dry run: re-run with --write to apply\n");
  }
  process.exit(plan.exitCode);
}

async function cmdMcp(argv: string[]): Promise<void> {
  const hostName = requireFlag(argv, "--host");
  const agentValue = requireFlag(argv, "--agent");
  const baseline = flag(argv, "--baseline");
  if (baseline !== undefined && baseline !== "brief" && baseline !== "full") die("--baseline must be brief or full");

  let host, agent;
  try {
    host = hostConfig(hostName);
    agent = parseAgent(agentValue);
  } catch (err) {
    die(`ck mcp: ${(err as Error).message}`);
  }

  const session = await createCliSession({
    config: resolveConfig(),
    host,
    agent,
    baseline: baseline as "brief" | "full" | undefined,
    timeoutMs: timeoutMs(),
  });

  // stdout 只走协议；日志已经落到 ~/.cinlan-knowledge/logs/
  const face = await createStdioFace(session.session, {
    onerror: (err) => logEvent("mcp.transport_error", { host: hostName, message: err.message }),
  });
  logEvent("mcp.started", {
    host: hostName,
    agent: `${agent.team}/${agent.name}`,
    agent_id: session.prepared?.agent_id ?? null,
    baseline: session.session.ctx.baseline,
    prepare: session.failure === null ? "ok" : session.failure.code,
  });
  // 后台物化不拦工具；进程退出时未完成的临时目录由下一次启动清理
  void session.background;
  await face.closed;
  await face.close();
  // 不直接 process.exit()：会话很短时（宿主探活）fetch 刚结束就强退，Windows 上会撞 libuv 断言、
  // 以 0xC0000409 退出。先让事件循环自然排空；后台请求还挂着的话最多再等 2 秒。
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 2000).unref();
}

async function cmdHook(argv: string[]): Promise<void> {
  const sub = argv[0];
  const hostName = requireFlag(argv, "--host");
  const agentValue = requireFlag(argv, "--agent");

  // 永远以 0 退出：hook 失败不能拖垮宿主会话。形状从宿主声明里先拿，拿不到退回 claude-code。
  let budgetChars = 8000;
  let shape: "claude-code" | "hermes-context" = "claude-code";
  let output: Record<string, unknown>;
  let host: HostConfig | null = null;
  let prepared: PreparedLoadout | null = null;
  try {
    host = hostConfig(hostName);
    const hook = host.hook;
    if (!hook) die(`host ${hostName} has no hook`);
    shape = hook.output;
    const expected = hookEventCli(hook.key);
    if (sub !== expected) {
      die(`host ${hostName} expects hook event "${expected}" (from ${hook.key}), got "${sub ?? ""}"`);
    }
    budgetChars = host.budgets.hook?.budget_chars ?? budgetChars;

    if (shape === "hermes-context") {
      // hermes shell hook 的 stdin 是 JSON 载荷；pre_llm_call 每个 LLM 调用都发，
      // 只在 extra.is_first_turn === true 时注入（首轮门控在 ck 侧，hosts.md §4.6）。
      const stdinText = await readStdin();
      let firstTurn = false;
      try {
        const payload = JSON.parse(stdinText.trim()) as { extra?: { is_first_turn?: unknown } } | null;
        firstTurn = payload?.extra?.is_first_turn === true;
      } catch {
        firstTurn = false;
      }
      if (!firstTurn) {
        process.stdout.write("{}\n");
        process.exitCode = 0;
        return;
      }
    }

    const result = await runHook({
      config: resolveConfig(),
      agent: parseAgent(agentValue),
      host: host.name,
      budgetChars,
      output: shape,
      timeoutMs: timeoutMs(),
    });
    output = result.json;
    prepared = result.prepared;
  } catch (err) {
    const code = err instanceof PrepareError ? err.code : "INTERNAL";
    logEvent("hook.failed", { host: hostName, code, message: (err as Error).message });
    // 读档还没开始就失败（宿主声明找不到、--agent 写错）也用 loadout.md §3 的错误提示块，与 runHook 同一个形状
    const context = errorInstructions(code as Parameters<typeof errorInstructions>[0]);
    output = wrapHookContext(context, shape);
  }
  process.stdout.write(JSON.stringify(output) + "\n");
  // skill 物化（loadout.md §6 步骤 5，hosts.md §5）：`ck mcp` 后台做，`ck hook` 在输出后做——
  // 没有它，brief 宿主要等到第二个会话（第二次 `ck mcp`）才拿到 skill 落盘。
  // 另计 10 秒（sync.ts 的 SYNC_TIMEOUT_MS），超时记日志退出；失败不影响已投递的文本，下次启动续做。
  if (host !== null && prepared !== null && prepared.skills.length > 0) {
    try {
      const result = await syncSkills({
        config: resolveConfig(),
        host,
        agentId: prepared.agent_id,
        skills: prepared.skills,
      });
      const conflicts = result.skipped.filter((s) => s.reason === "conflict");
      if (conflicts.length > 0) {
        logEvent("hook.skills_conflict", { host: hostName, agent_id: prepared.agent_id, skipped: conflicts });
      }
    } catch (err) {
      logEvent("hook.skills_failed", { host: hostName, agent_id: prepared.agent_id, message: (err as Error).message });
    }
  }
  // 不调 process.exit()：fetch 刚结束就强退，Windows 上会撞 libuv 断言、以 0xC0000409 退出，
  // 破坏"永远以 0 退出"。设好退出码，让事件循环自然排空。
  process.exitCode = 0;
}

async function cmdSkills(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "sync") die("usage: ck skills sync --host <h> --agent <team>/<name>");
  const hostName = requireFlag(argv, "--host");
  const agentValue = requireFlag(argv, "--agent");

  let host, agent;
  try {
    host = hostConfig(hostName);
    agent = parseAgent(agentValue);
  } catch (err) {
    die(`ck skills sync: ${(err as Error).message}`);
  }

  const config = resolveConfig();
  try {
    const { agent_id, ...result } = await runSkillsSync({ config, host, agent, timeoutMs: timeoutMs() });
    process.stdout.write(JSON.stringify({ ok: true, agent_id, skill_dir: host.skill_dir, ...result }, null, 2) + "\n");
  } catch (err) {
    const code = err instanceof PrepareError ? err.code : "INTERNAL";
    process.stdout.write(JSON.stringify({ ok: false, code, message: (err as Error).message }) + "\n");
    process.exitCode = 1;
  }
}

async function cmdImport(argv: string[]): Promise<void> {
  const source = requireFlag(argv, "--source");
  const config = requireConfig();
  let host;
  try {
    host = hostConfig(source);
  } catch (err) {
    die(`ck import: ${(err as Error).message}`);
  }
  try {
    const report = await runImport({
      config,
      host,
      workspace: flag(argv, "--workspace"),
      team: flag(argv, "--team"),
      yes: has(argv, "--yes"),
      update: has(argv, "--update"),
      dryRun: has(argv, "--dry-run"),
      timeoutMs: timeoutMs(),
    });
    process.exitCode = report.failed > 0 ? 1 : 0;
  } catch (err) {
    if (!(err instanceof PrepareError) && !(err instanceof KnowledgeRpcError)) throw err;
    // 可能刚收完 auth/verify 的应答：不走 die()（见 cmdHook 末尾的说明），设退出码让事件循环排空
    process.stderr.write(`ck import: ${err.message}\n`);
    process.exitCode = 1;
  }
}

async function cmdDoctor(argv: string[]): Promise<void> {
  const { result, ok } = await runDoctor({ config: resolveConfig(), host: flag(argv, "--host") });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = ok ? 0 : 1;
}

async function cmdEmbeddings(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "sync") {
    die("usage: ck embeddings sync --url <base> --model <m> [--api-key <k>] [--team <slug>] [--limit <n>] [--dry-run]");
  }
  const rest = argv.slice(1);
  const url = flag(rest, "--url") ?? process.env.CK_EMBED_URL;
  const model = flag(rest, "--model") ?? process.env.CK_EMBED_MODEL;
  const apiKey = flag(rest, "--api-key") ?? process.env.CK_EMBED_KEY;
  if (url === undefined || url === "") die("--url is required (or set CK_EMBED_URL)");
  if (model === undefined || model === "") die("--model is required (or set CK_EMBED_MODEL)");
  const config = requireConfig();
  try {
    const report = await runEmbeddingsSync({
      config,
      url,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      team: flag(rest, "--team"),
      limit: flag(rest, "--limit") !== undefined ? Number(flag(rest, "--limit")) : undefined,
      dryRun: has(rest, "--dry-run"),
      timeoutMs: timeoutMs(),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    if (!(err instanceof PrepareError) && !(err instanceof KnowledgeRpcError)) throw err;
    // 可能刚收完 hub 的应答：不走 die()（同 cmdImport），设退出码让事件循环排空
    process.stderr.write(`ck embeddings sync: ${err.message}\n`);
    process.exitCode = 1;
  }
}

async function cmdReflect(argv: string[]): Promise<void> {
  const teamSlug = flag(argv, "--team");
  const url = flag(argv, "--url") ?? process.env.CK_LLM_URL;
  const model = flag(argv, "--model") ?? process.env.CK_LLM_MODEL;
  const apiKey = flag(argv, "--api-key") ?? process.env.CK_LLM_KEY;
  if (url === undefined || url === "") die("--url is required (or set CK_LLM_URL)");
  if (model === undefined || model === "") die("--model is required (or set CK_LLM_MODEL)");
  const config = requireConfig();

  // --team <slug>：批处理模式（对团队全部活跃资产跑 reflect，按草稿关联度排序）
  if (teamSlug !== undefined) {
    try {
      const report = await runReflectTeam({
        config,
        team: teamSlug,
        url,
        model,
        ...(apiKey !== undefined ? { apiKey } : {}),
        limit: flag(argv, "--limit") !== undefined ? Number(flag(argv, "--limit")) : undefined,
        dryRun: has(argv, "--dry-run"),
        timeoutMs: timeoutMs(),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exitCode = report.ok ? 0 : 1;
    } catch (err) {
      if (!(err instanceof PrepareError) && !(err instanceof KnowledgeRpcError)) throw err;
      process.stderr.write(`ck reflect: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // 单资产模式（原行为）
  const assetId = requireFlag(argv, "--asset");
  try {
    const report = await runReflect({
      config,
      assetId,
      url,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      team: flag(argv, "--team"),
      dryRun: has(argv, "--dry-run"),
      timeoutMs: timeoutMs(),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    if (!(err instanceof PrepareError) && !(err instanceof KnowledgeRpcError)) throw err;
    process.stderr.write(`ck reflect: ${err.message}\n`);
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ 分发

(async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--version" || command === "-v") {
    process.stdout.write(`ck ${VERSION}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "rpc") await cmdRpc(rest);
  else if (command === "login") await cmdLogin(rest);
  else if (command === "setup") await cmdSetup(rest);
  else if (command === "mcp") await cmdMcp(rest);
  else if (command === "hook") await cmdHook(rest);
  else if (command === "skills") await cmdSkills(rest);
  else if (command === "doctor") await cmdDoctor(rest);
  else if (command === "import") await cmdImport(rest);
  else if (command === "embeddings") await cmdEmbeddings(rest);
  else if (command === "reflect") await cmdReflect(rest);
  else if (command && NOT_YET.includes(command)) die(`ck ${command}: not implemented in P1 (see docs/sop.md §C)`);
  else die(USAGE);
})().catch((err: unknown) => {
  // 兜底：走到这里说明有分支没自己处理错误，原样打出来而不是吞掉
  die(`ck: ${(err as Error).message}`);
});
