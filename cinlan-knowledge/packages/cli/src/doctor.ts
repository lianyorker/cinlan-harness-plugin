import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ckHome, type ResolvedConfig } from "./config.js";
import { KnowledgeRpcError } from "@cinlan/knowledge-mcp";
import { isErrorCode, type Verification } from "@cinlan/knowledge-sdk";
import { hostConfig, hookEventCli, hookEventName, knownHosts } from "./hosts.js";
import { PrepareError, callEnvelope } from "./prepare.js";
import { expandHome } from "./paths.js";
import { commandHookHash, findHookIndices } from "./setup.js";
import { yamlChildBlock } from "./yamlcfg.js";
import { VERSION } from "./version.js";

/**
 * `ck doctor [--host <h>]`（hosts.md §5）：hub 连通、key、Agent、resolve、宿主配置、hook 条目、skill 目录、缓存、版本。
 * 只读，不改任何东西；每项各自成败，不因一项失败跳过其余项。
 * 带 `--host` 时从该宿主的配置里读出 Agent 名，再做 `agent/ensure` 与 `loadout/resolve` 探针。
 * 宿主配置按 install.md §5 的口径查四件事：条目存在、指向本机 ck、hook 条目（含 codex 信任表）、skill 目录可写。
 */

export interface DoctorOptions {
  config: ResolvedConfig;
  /**
   * 覆盖用：同时充当 ck 状态目录（结果里的 `home`）与宿主路径里 `~` 的展开根。
   * 缺省时两者各取各的：状态目录 ckHome()，`~` 是 os.homedir()。
   */
  home?: string;
  host?: string;
  fetchImpl?: typeof fetch;
  /** 测试用：`%VAR%` 展开从该 env 取；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 「指向本机 ck」用的 ck 入口绝对路径；缺省当前模块旁的 bin.js（`ck` 的 lib/bin.js）。 */
  ckEntry?: string;
}

interface Check {
  ok: boolean;
  detail?: unknown;
}

function codeOf(err: unknown): string {
  if (err instanceof PrepareError) return err.code;
  if (err instanceof KnowledgeRpcError) return isErrorCode(err.code) ? err.code : "INTERNAL";
  return "INTERNAL";
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** YAML `command: <标量>` 行取值：单引号（`''` 转义）、双引号、裸值各自还原；不是单行 `command:` 返回 null。 */
function yamlCommandOf(line: string): string | null {
  const m = /^\s*(?:-\s*)?command:\s*(.*?)\s*$/.exec(line);
  if (m === null) return null;
  const value = m[1]!;
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return value.replace(/\s+#.*$/, "");
}

function getPath(root: unknown, dotted: string): unknown {
  let node: unknown = root;
  for (const part of dotted.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** 宿主配置里找 `--agent <team>/<name>`：JSON 配置读条目，YAML/TOML 配置整段搜。 */
function agentFromHostJson(key: string, file: string): string | null {
  if (!existsSync(file)) return null;
  const doc = readJson(file);
  const entry = getPath(doc, key) as { args?: unknown; command?: unknown } | undefined;
  // `args` 分写（claude/gemini）或 argv 数组 `command`（opencode type:local）；远端条目看 x-ck-agent 头
  const argv = Array.isArray(entry?.args)
    ? entry.args
    : Array.isArray(entry?.command)
      ? entry.command
      : null;
  if (argv !== null) {
    const i = argv.indexOf("--agent");
    return typeof argv[i + 1] === "string" ? (argv[i + 1] as string) : null;
  }
  const headers = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["headers"] : undefined;
  const agent = headers !== null && typeof headers === "object" ? (headers as Record<string, unknown>)["x-ck-agent"] : undefined;
  return typeof agent === "string" ? agent : null;
}

function agentFromBlock(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  // 只看 ck 管理的块（YAML 与 TOML 同标记），避免把别家条目的参数读进来
  const begin = text.indexOf("# >>> cinlan-knowledge");
  const end = text.indexOf("# <<< cinlan-knowledge");
  const scope = begin >= 0 && end > begin ? text.slice(begin, end) : "";
  if (!scope.includes(key)) return null;
  const match =
    /--agent['"]?,\s*['"]?([^'",\s]+)/.exec(scope) ?? /x-ck-agent["'\s:=]+([^'",\s]+)/.exec(scope);
  return match?.[1] ?? null;
}

/** hermes `mcp_servers.ck:` 嵌套条目里挖 `--agent <team>/<name>`（args 流式/块式均可；http 看 header）。 */
function agentFromYamlNested(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  const parts = key.split(".");
  if (parts.length !== 2) return null;
  const block = yamlChildBlock(readFileSync(file, "utf8"), parts[0]!, parts[1]!);
  if (block === null) return null;
  const text = block.join("\n");
  const match =
    /--agent[\s'"\[\],/-]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(text) ??
    /x-ck-agent:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(text);
  return match?.[1] ?? null;
}

/** win32 大小写不敏感、分隔符统一后比路径（setup 写入的路径与当前模块路径都可能是两种斜杠）。 */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

/** stdio 条目的 argv（判「指向本机 ck」用）：JSON 读条目的 args / command 数组。 */
function argvFromHostJson(key: string, file: string): string[] | null {
  if (!existsSync(file)) return null;
  const doc = readJson(file);
  const entry = getPath(doc, key) as { args?: unknown; command?: unknown } | undefined;
  const argv = Array.isArray(entry?.args) ? entry.args : Array.isArray(entry?.command) ? entry.command : null;
  return argv !== null && argv.every((a) => typeof a === "string") ? (argv as string[]) : null;
}

/** 标记块里的 `args: [...]` / `args = [...]`（yaml insert 与 toml 共用；逐项剥一层引号）。 */
function argvFromBlock(file: string, key: string): string[] | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const begin = text.indexOf("# >>> cinlan-knowledge");
  const end = text.indexOf("# <<< cinlan-knowledge");
  const scope = begin >= 0 && end > begin ? text.slice(begin, end) : "";
  if (!scope.includes(key)) return null;
  const match = /args\s*[=:]\s*\[([^\]]*)\]/.exec(scope);
  if (match === null) return null;
  return match[1]!
    .split(",")
    .map((token) => token.trim().replace(/^['"]|['"]$/g, ""))
    .filter((token) => token !== "");
}

/** hermes `mcp_servers.ck:` 嵌套条目里的 `args: [...]`。 */
function argvFromYamlNested(file: string, key: string): string[] | null {
  if (!existsSync(file)) return null;
  const parts = key.split(".");
  if (parts.length !== 2) return null;
  const block = yamlChildBlock(readFileSync(file, "utf8"), parts[0]!, parts[1]!);
  if (block === null) return null;
  const match = /args:\s*\[([^\]]*)\]/.exec(block.join("\n"));
  if (match === null) return null;
  return match[1]!
    .split(",")
    .map((token) => token.trim().replace(/^['"]|['"]$/g, ""))
    .filter((token) => token !== "");
}

/** config.toml 里所有 `[hooks.state.'<键>']` / `[hooks.state."<键>"]` 表：enabled 与 trusted_hash。 */
function tomlTrustStates(
  text: string,
): Map<string, { enabled: boolean; hash: string | null }> {
  const out = new Map<string, { enabled: boolean; hash: string | null }>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[hooks\.state\.(['"])(.*?)\1\]\s*$/.exec(lines[i]!);
    if (header === null) continue;
    let key = header[2]!;
    if (header[1] === '"') {
      try {
        key = JSON.parse(`"${key}"`) as string;
      } catch {
        // 转不出来按原样比；对不上就是没信任
      }
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j]!); j++) body.push(lines[j]!);
    const text = body.join("\n");
    out.set(key, {
      enabled: /\benabled\s*=\s*true\b/.test(text),
      hash: /\btrusted_hash\s*=\s*(['"])(.*?)\1/.exec(text)?.[2] ?? null,
    });
  }
  return out;
}

/** 目录可写探测：写一个临时文件再删。 */
function canWriteInto(dir: string): boolean {
  try {
    const probe = join(dir, `.ck-doctor-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** skill 目录判据（acceptance-report §5.5 取 A）：存在且可写；不存在时最近的已存在祖目录可写（物化时能 mkdir）。 */
function dirWritableProbe(dir: string): { ok: boolean; exists: boolean; writable: boolean } {
  let probeDir = dir;
  if (!existsSync(dir)) {
    for (;;) {
      const up = dirname(probeDir);
      if (existsSync(probeDir)) break;
      if (up === probeDir) return { ok: false, exists: false, writable: false };
      probeDir = up;
    }
  }
  const writable = canWriteInto(probeDir);
  return { ok: writable, exists: existsSync(dir), writable };
}

export async function runDoctor(options: DoctorOptions): Promise<{ result: Record<string, unknown>; ok: boolean }> {
  const home = options.home ?? ckHome();
  const { config } = options;
  const checks: Record<string, Check> = {};

  checks.config = {
    ok: config.hub !== null && config.key !== null,
    detail: { hub: config.hub, sources: config.sources, key: config.key === null ? "missing" : "present" },
  };

  let teamSlugs: string[] = [];
  if (config.hub !== null && config.key !== null) {
    try {
      const data = await callEnvelope({
        hub: config.hub,
        key: config.key,
        action: "auth/verify",
        body: {},
        timeoutMs: 5000,
        fetchImpl: options.fetchImpl,
      });
      const user = data["user"] as { id?: unknown; name?: unknown } | undefined;
      // 字段名跟着 sdk 的 Verification 走：团队 slug 在 `team`，不是 `name`
      const teams = Array.isArray(data["teams"]) ? (data["teams"] as Partial<Verification["teams"][number]>[]) : [];
      teamSlugs = teams.flatMap((t) => (typeof t.team === "string" ? [t.team] : []));
      const serverVersion = typeof data["server_version"] === "string" ? data["server_version"] : null;
      checks.hub = { ok: true, detail: { server_version: serverVersion } };
      checks.key = { ok: typeof user?.name === "string", detail: { user: user?.name ?? null, teams: teamSlugs } };
      // 版本只做同源对比，不做"必须相等"判定：ck 可以先于 hub 发布。
      checks.version = {
        ok: true,
        detail: { ck: VERSION, hub: serverVersion, same: serverVersion === VERSION },
      };
    } catch (err) {
      const code = codeOf(err);
      checks.hub = { ok: false, detail: { code, message: (err as Error).message } };
      checks.key = { ok: false, detail: { code } };
    }
  } else {
    checks.hub = { ok: false, detail: { message: "hub url or key missing" } };
  }

  if (options.host !== undefined) {
    const hostName = options.host;
    let host;
    try {
      host = hostConfig(hostName);
    } catch (err) {
      checks.host_config = { ok: false, detail: { message: (err as Error).message, known: knownHosts() } };
      return { result: { home, host: hostName, checks }, ok: false };
    }

    // 宿主路径里的 `~` 是用户 home，不是上面那个 ck 状态目录
    const env = options.env ?? process.env;
    const mcpFile = expandHome(host.mcp.file, options.home, env);
    const declared =
      host.mcp.insert || host.mcp.format === "toml"
        ? agentFromBlock(mcpFile, host.mcp.key)
        : host.mcp.format === "json"
          ? agentFromHostJson(host.mcp.key, mcpFile)
          : host.mcp.format === "yaml"
            ? agentFromYamlNested(mcpFile, host.mcp.key)
            : null;
    const hostReadable = host.mcp.file !== "" && existsSync(mcpFile);
    // 「指向本机 ck」（install.md §5）：stdio 条目的 argv 里应能找到 ck 自己的入口。
    // http 条目没有本地入口，n/a；http 的指向是否等于登录的 hub 交给 key / agent 探针去暴露。
    const ckSelfEntry = options.ckEntry ?? fileURLToPath(new URL("./bin.js", import.meta.url));
    const entryArgv =
      host.mcp.insert || host.mcp.format === "toml"
        ? argvFromBlock(mcpFile, host.mcp.key)
        : host.mcp.format === "json"
          ? argvFromHostJson(host.mcp.key, mcpFile)
          : argvFromYamlNested(mcpFile, host.mcp.key);
    const pointsToSelf = entryArgv === null ? null : entryArgv.some((arg) => samePath(arg, ckSelfEntry));
    checks.host_config = {
      ok: hostReadable && declared !== null && pointsToSelf !== false,
      detail: {
        file: host.mcp.file === "" ? null : mcpFile,
        exists: hostReadable,
        agent: declared,
        points_to_self: pointsToSelf,
        // 文件在、条目不在，或文件本身不存在（§6.3：cinlan-harness 即后一种）都给同一条 hint；
        // 没声明配置文件的宿主（generic）不提示——它本来就不落文件。
        hint: host.mcp.file !== "" && (!hostReadable || declared === null) ? "run `ck setup --write` for this host" : undefined,
      },
    };

    const skillDir = expandHome(host.skill_dir, options.home, env);
    const skillProbe = dirWritableProbe(skillDir);
    checks.skill_dir = {
      ok: skillProbe.ok,
      detail: { path: skillDir, exists: skillProbe.exists, writable: skillProbe.writable },
    };

    // hook 条目（install.md §5）：yaml（hermes）查条目与批准；json（claude-code / gemini-cli / codex）
    // 查条目本身，声明了信任的（codex）再查 `[hooks.state.*]` 的 enabled + trusted_hash 复算一致。
    const hook = host.hook;
    if (hook !== null && hook.format === "json") {
      const detail: Record<string, unknown> = {};
      const hookFile = expandHome(hook.file, options.home, env);
      detail["hook_file"] = hookFile;
      const hookDoc = readJson(hookFile);
      const found = hookDoc !== null ? findHookIndices(hookDoc, hook) : null;
      let hookOk = found !== null;
      detail["hook_present"] = hookOk;
      if (hook.trust !== undefined) {
        const trustFile = expandHome(hook.trust.file, options.home, env);
        detail["trust_file"] = trustFile;
        const event = hookEventName(hook.key);
        const stateKey = found !== null ? `${hookFile}:${event}:${found.group}:${found.handler}` : null;
        const states = existsSync(trustFile) ? tomlTrustStates(readFileSync(trustFile, "utf8")) : new Map();
        const state = stateKey !== null ? states.get(stateKey) : undefined;
        detail["trust_entry_present"] = state !== undefined;
        detail["trust_enabled"] = state !== undefined ? state.enabled : null;
        let hashMatches: boolean | null = null;
        if (found !== null && state !== undefined && hookDoc !== null) {
          const groups = getPath(hookDoc, hook.key) as Array<Record<string, unknown>>;
          const handlers = groups[found.group]?.["hooks"] as Array<Record<string, unknown>> | undefined;
          const handler = handlers?.[found.handler];
          const command = typeof handler?.["command"] === "string" ? handler["command"] : null;
          const timeout = typeof handler?.["timeout"] === "number" ? handler["timeout"] : 60;
          if (command !== null) {
            const expected = commandHookHash({ event, matcher: hook.matcher, command, timeoutSec: timeout });
            hashMatches = state.hash !== null && state.hash === expected;
          }
        }
        detail["trusted_hash_matches"] = hashMatches;
        hookOk = hookOk && state !== undefined && state.enabled && hashMatches === true;
      }
      checks.hook = { ok: hookOk, detail };
    } else if (hook !== null && hook.format === "yaml") {
      const detail: Record<string, unknown> = {};
      let hookOk = false;
      let commands: Array<string | null> = [];
      const hookFile = expandHome(hook.file, options.home, env);
      detail["hook_file"] = hookFile;
      if (existsSync(hookFile)) {
        const parts = hook.key.split(".");
        const block = parts.length === 2 ? yamlChildBlock(readFileSync(hookFile, "utf8"), parts[0]!, parts[1]!) : null;
        const mine = (block ?? []).filter((l) => l.includes(`hook ${hookEventCli(hook.key)}`));
        hookOk = mine.length > 0;
        commands = mine.map(yamlCommandOf);
      }
      detail["hook_present"] = hookOk;
      if (hook.consent !== undefined) {
        const consentFile = expandHome(hook.consent.file, options.home, env);
        detail["consent_file"] = consentFile;
        // hermes：根 `{"approvals": [...]}`，逐条按 (event, command) 全等匹配；config.yaml 里的命令差一个字符就算没批准。
        const approvals = readJson(consentFile)?.["approvals"];
        const event = hookEventName(hook.key);
        const approved =
          hookOk &&
          Array.isArray(approvals) &&
          commands.every(
            (command) =>
              command !== null &&
              approvals.some(
                (e: unknown) =>
                  e !== null && typeof e === "object" && !Array.isArray(e) &&
                  (e as Record<string, unknown>)["event"] === event &&
                  (e as Record<string, unknown>)["command"] === command,
              ),
          );
        detail["approved"] = approved;
        checks.hook = { ok: hookOk && approved, detail };
      } else {
        checks.hook = { ok: hookOk, detail };
      }
    }

    // 探针预算：claude-code / codex / gemini-cli / hermes 只声明 hook 预算，取 instructions ?? hook
    //（与 sync.ts / mcp.ts 同口径；max_bytes 只有 instructions 档才有意义）。
    const probeBudget = host.budgets.instructions ?? host.budgets.hook;

    if (declared !== null && config.hub !== null && config.key !== null) {
      const slash = declared.indexOf("/");
      const team = slash > 0 ? declared.slice(0, slash) : "";
      const name = slash > 0 ? declared.slice(slash + 1) : "";
      const knownTeam = team !== "" && teamSlugs.includes(team);
      try {
        const ensured = await callEnvelope({
          hub: config.hub,
          key: config.key,
          action: "agent/ensure",
          body: { team, name, host: hostName },
          timeoutMs: 5000,
          fetchImpl: options.fetchImpl,
        });
        const agent = ensured["agent"] as { id?: unknown; name?: unknown; host?: unknown } | undefined;
        checks.agent = { ok: typeof agent?.id === "string", detail: { team_visible: knownTeam, agent: agent?.id ?? null, host: agent?.host ?? null } };
        if (typeof agent?.id === "string") {
          const resolved = await callEnvelope({
            hub: config.hub,
            key: config.key,
            action: "loadout/resolve",
            body: {
              agent_id: agent.id,
              ...(probeBudget ? { budget_chars: probeBudget.budget_chars, max_bytes: host.budgets.instructions?.max_bytes } : {}),
            },
            timeoutMs: 5000,
            fetchImpl: options.fetchImpl,
          });
          checks.resolve = {
            ok: true,
            detail: {
              digest: resolved["digest"] ?? null,
              chars: resolved["chars"] ?? null,
              bytes: resolved["bytes"] ?? null,
              items: Array.isArray(resolved["items"]) ? (resolved["items"] as unknown[]).length : null,
              skills: Array.isArray(resolved["skills"]) ? (resolved["skills"] as { name?: unknown }[]).map((s) => s.name ?? null) : null,
              skipped: resolved["skipped"] ?? null,
            },
          };
        }
      } catch (err) {
        const code = codeOf(err);
        checks.agent = { ...(checks.agent ?? { ok: false }), ok: false, detail: { code, message: (err as Error).message } };
      }
    }
  }

  // 缓存状态（install.md §5）：现状通报，不计成败——目录缺失只是还没跑过会话，不是故障。
  const cacheDir = join(home, "cache");
  let cacheEntries: number | null = null;
  try {
    cacheEntries = readdirSync(cacheDir).length;
  } catch {
    cacheEntries = null;
  }
  checks.cache = { ok: true, detail: { path: cacheDir, entries: cacheEntries } };

  const ok = Object.values(checks).every((c) => c.ok);
  return { result: { home, host: options.host ?? null, ck_version: VERSION, checks }, ok };
}
