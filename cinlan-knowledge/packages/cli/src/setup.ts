import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AgentSpec } from "./prepare.js";
import type { HostConfig } from "./hosts.js";
import { hookEventCli, hookEventName } from "./hosts.js";
import { expandHome } from "./paths.js";
import { mergeYamlListEntry, mergeYamlMapEntry } from "./yamlcfg.js";

/**
 * `ck setup`（hosts.md §5）：生成宿主配置改动，默认只打印，`--write` 才落盘并备份。
 * - JSON：结构化合并；同名条目内容一致视为幂等。条目名 `ck` 归 ck 所有——内容不同 → 原地
 *   更新（与 yaml / toml 的标记块同口径，2026-11-14 拍板，acceptance-report §5.9）；剩下的
 *   冲突只有结构性问题（文件不是合法 JSON、`hooks.<event>` 不是列表、allowlist 根形状不对）。
 * - YAML / TOML：追加一段带起止标记的块；块归 `ck` 所有，重复执行原地更新、不重复追加。
 * - `--rules`：往宿主规则文件写一段带标记的说明块。
 * 写进宿主配置的命令一律是 `node <ck 绝对路径> …`，不依赖 PATH。
 */

export interface SetupOptions {
  host: HostConfig;
  agent: AgentSpec;
  transport: "stdio" | "http";
  /** `ck` 入口绝对路径（lib/bin.js）。 */
  ckEntry: string;
  /** `--transport http` 时需要。 */
  hubUrl?: string | null;
  rules: boolean;
  /** 测试用：`~` 展开到该目录；缺省 os.homedir()。 */
  home?: string;
  /** 测试用：`%VAR%` 展开从该 env 取；缺省 process.env（win32 的 %LOCALAPPDATA% 依赖它）。 */
  env?: NodeJS.ProcessEnv;
}

export interface FileChange {
  file: string;
  format: "json" | "yaml" | "toml" | "markdown";
  /**
   * create/update：要落盘；unchanged：目标已一致；conflict：目标存在且内容不同，拒绝覆盖。
   */
  status: "create" | "update" | "unchanged" | "conflict";
  before: string | null;
  after: string | null;
  /** 冲突详情或变更说明。 */
  detail?: string;
  /**
   * ck 管的那段内容（yaml / toml 的标记块、json 的条目、markdown 的规则块）。
   * dry-run 时打印它——不打印整个文件（settings.json 里有别人的 token），conflict 与 unchanged 不填。
   */
  preview?: string;
}

export interface SetupPlan {
  changes: FileChange[];
  /** 有冲突时不为 0；调用方据此决定退出码。 */
  exitCode: 0 | 1;
}

const YAML_BEGIN = "# >>> cinlan-knowledge (managed by ck setup; delete this block to detach)";
const YAML_END = "# <<< cinlan-knowledge";
const TOML_BEGIN = "# >>> cinlan-knowledge (managed by ck setup; delete this block to detach)";
const TOML_END = "# <<< cinlan-knowledge";
const RULES_BEGIN = "<!-- >>> cinlan-knowledge (managed by ck setup; delete this block to detach) -->";
const RULES_END = "<!-- <<< cinlan-knowledge -->";

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function getPath(root: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = root;
  for (const part of dotted.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = node[part];
    if (next === undefined) node[part] = {};
    else if (!isPlainObject(next)) throw new Error(`config path ${dotted} collides with a non-object at ${part}`);
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/** 期望写进宿主的 MCP 条目（JSON 形状；YAML 模板另行渲染）。 */
export function mcpEntry(options: SetupOptions): Record<string, unknown> {
  const agent = `${options.agent.team}/${options.agent.name}`;
  if (options.transport === "http") {
    if (!options.hubUrl) throw new Error("--transport http requires a hub url (CK_HUB_URL or `ck login --hub`)");
    // key 不进宿主配置（loadout.md §6）；远端条目靠宿主自己的 header / headersHelper 机制补 Authorization
    const entry: Record<string, unknown> = {
      type: options.host.mcp.remote_type ?? "http",
      url: `${options.hubUrl.replace(/\/+$/, "")}/mcp`,
      headers: { "x-ck-agent": agent, "x-ck-host": options.host.name, "x-ck-baseline": options.host.instructions },
    };
    if (options.host.mcp.trust === true) entry["trust"] = true;
    return entry;
  }
  const args = [options.ckEntry, "mcp", "--host", options.host.name, "--agent", agent];
  if (options.host.instructions === "full") args.push("--baseline", "full");
  // opencode `type: "local"`：command 是整条 argv 数组，无 args 字段（hosts.md §4.7）
  const entry: Record<string, unknown> = options.host.mcp.argv === true
    ? { type: "local", command: ["node", ...args] }
    : { command: "node", args };
  if (options.host.mcp.trust === true) entry["trust"] = true;
  return entry;
}

/** 写进宿主配置 / allowlist 的 hook 命令行；两处必须逐字符一致（hermes 按 (event, command) 精确匹配）。 */
export function hookCommand(options: SetupOptions): string {
  const hook = options.host.hook;
  if (!hook) throw new Error(`host ${options.host.name} has no hook`);
  return `node "${options.ckEntry}" hook ${hookEventCli(hook.key)} --host ${options.host.name} --agent ${options.agent.team}/${options.agent.name}`;
}

/** 期望写进宿主的 hook 条目（Claude Code 形状，hosts.md §4.3；codex 同款，§4.4）。 */
export function hookEntry(options: SetupOptions): Record<string, unknown> {
  const hook = options.host.hook;
  if (!hook) throw new Error(`host ${options.host.name} has no SessionStart hook`);
  const handler: Record<string, unknown> = {
    type: "command",
    command: hookCommand(options),
  };
  if (hook.name !== undefined) handler["name"] = hook.name;
  if (hook.timeout_ms !== undefined) handler["timeout"] = hook.timeout_ms;
  else if (hook.timeout_sec !== undefined) handler["timeout"] = hook.timeout_sec;
  return { matcher: hook.matcher, hooks: [handler] };
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** hermes `mcp_servers.ck:` 条目行（相对缩进：首行 `ck:`，余行行已含缩进）。 */
export function renderYamlMcpEntry(options: SetupOptions): string[] {
  const agent = `${options.agent.team}/${options.agent.name}`;
  const child = options.host.mcp.key.split(".").pop()!;
  if (options.transport === "http") {
    if (!options.hubUrl) throw new Error("--transport http requires a hub url (CK_HUB_URL or `ck login --hub`)");
    return [
      `${child}:`,
      `  url: ${yamlQuote(`${options.hubUrl.replace(/\/+$/, "")}/mcp`)}`,
      "  headers:",
      `    x-ck-agent: ${yamlQuote(agent)}`,
      `    x-ck-host: ${yamlQuote(options.host.name)}`,
      `    x-ck-baseline: ${yamlQuote(options.host.instructions)}`,
    ];
  }
  const args = [options.ckEntry, "mcp", "--host", options.host.name, "--agent", agent];
  if (options.host.instructions === "full") args.push("--baseline", "full");
  return [`${child}:`, "  command: node", `  args: [${args.map(yamlQuote).join(", ")}]`];
}

/** hermes `hooks.pre_llm_call:` 列表项（相对缩进：首行 `- command:`）。 */
export function renderYamlHookItem(options: SetupOptions): string[] {
  const hook = options.host.hook;
  if (!hook) throw new Error(`host ${options.host.name} has no hook`);
  const lines = [`- command: ${yamlQuote(hookCommand(options))}`];
  if (hook.timeout_sec !== undefined) lines.push(`  timeout: ${hook.timeout_sec}`);
  return lines;
}

/** dsh 系 `insert` 块（hosts.md §4.2）。 */
export function renderYamlBlock(options: SetupOptions): string {
  const agent = `${options.agent.team}/${options.agent.name}`;
  const lines = [
    "- insert:",
    `    - id: ${options.host.mcp.key}`,
    `      name: ${yamlQuote(options.host.mcp.plugin ?? options.host.mcp.key)}`,
    "      config:",
    "        serverName: ck",
  ];
  if (options.transport === "http") {
    if (!options.hubUrl) throw new Error("--transport http requires a hub url (CK_HUB_URL or `ck login --hub`)");
    lines.push("        transport: streamable-http");
    lines.push(`        url: ${yamlQuote(`${options.hubUrl.replace(/\/+$/, "")}/mcp`)}`);
    lines.push("        headers:");
    lines.push(`          x-ck-agent: ${yamlQuote(agent)}`);
    lines.push(`          x-ck-host: ${yamlQuote(options.host.name)}`);
    lines.push(`          x-ck-baseline: ${yamlQuote(options.host.instructions)}`);
  } else {
    lines.push("        transport: stdio");
    lines.push("        command: node");
    const args = [options.ckEntry, "mcp", "--host", options.host.name, "--agent", agent];
    if (options.host.instructions === "full") args.push("--baseline", "full");
    lines.push(`        args: [${args.map(yamlQuote).join(", ")}]`);
  }
  return [YAML_BEGIN, ...lines, YAML_END].join("\n");
}

/** TOML 字符串：优先字面串，含 `'` 时退回基本串转义。 */
function tomlString(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** TOML 表键：路径含反斜杠也用字面串；同样处理 `'` 兜底。 */
const tomlKey = tomlString;

/** `[mcp_servers.ck]` 一类的表头检测：`[ mcp_servers . 'ck' ]` / `[mcp_servers."ck"]` 也算。 */
function tomlTablePresent(text: string, key: string): boolean {
  const parts = key.split(".").map((p) => `["']?\s*${escapeRegExp(p)}\s*["']?`);
  return new RegExp(`^\\s*\\[\\s*${parts.join("\\s*\\.\\s*")}\\s*\\]`, "m").test(text);
}

/**
 * 期望写进 TOML 宿主配置的 MCP 块（codex `~/.codex/config.toml`，hosts.md §4.4）。
 * 块里只放 `[<key>]` 一个新表；`[features]` 这类可能已有声明的表不写，防重复定义。
 */
export function renderTomlBlock(options: SetupOptions): string {
  const agent = `${options.agent.team}/${options.agent.name}`;
  const lines = [`[${options.host.mcp.key}]`];
  if (options.transport === "http") {
    if (!options.hubUrl) throw new Error("--transport http requires a hub url (CK_HUB_URL or `ck login --hub`)");
    // codex `mcp_types.rs` 字段：url / bearer_token_env_var / http_headers。
    lines.push(`url = ${tomlString(`${options.hubUrl.replace(/\/+$/, "")}/mcp`)}`);
    lines.push('bearer_token_env_var = "CK_USER_KEY"');
    lines.push(
      `http_headers = { "x-ck-agent" = ${tomlString(agent)}, "x-ck-host" = ${tomlString(options.host.name)}, "x-ck-baseline" = ${tomlString(options.host.instructions)} }`,
    );
  } else {
    lines.push('command = "node"');
    const args = [options.ckEntry, "mcp", "--host", options.host.name, "--agent", agent];
    if (options.host.instructions === "full") args.push("--baseline", "full");
    lines.push(`args = [${args.map(tomlString).join(", ")}]`);
  }
  return [TOML_BEGIN, ...lines, TOML_END].join("\n");
}

/** canonical JSON（键递归排序、紧凑）——codex `command_hook_hash` 的序列化形状。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * codex `command_hook_hash`：identity = { event_name, matcher?, hooks: [handler] } 的 canonical
 * JSON 取 sha256。handler 形状 { type, command, timeout, async }，与 codex 归一化一致（Windows 用
 * commandWindows 覆盖 command 后的生效值；我们的条目不写 commandWindows）。
 */
export function commandHookHash(input: {
  event: string;
  matcher?: string;
  command: string;
  timeoutSec: number;
}): string {
  const identity: Record<string, unknown> = {
    event_name: input.event,
    hooks: [{ type: "command", command: input.command, timeout: Math.max(1, input.timeoutSec), async: false }],
  };
  if (input.matcher !== undefined) identity["matcher"] = input.matcher;
  return `sha256:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`;
}

/** 在规划后的 hooks.json 里找我们 handler 的 (group, handler) 下标；找不到返回 null。doctor 的信任表复算也用它。 */
export function findHookIndices(
  doc: Record<string, unknown>,
  hook: NonNullable<HostConfig["hook"]>,
): { group: number; handler: number } | null {
  const groups = getPath(doc, hook.key);
  if (!Array.isArray(groups)) return null;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (!isPlainObject(group) || group["matcher"] !== hook.matcher) continue;
    const handlers = group["hooks"];
    if (!Array.isArray(handlers)) continue;
    for (let h = 0; h < handlers.length; h++) {
      const entry = handlers[h];
      if (isPlainObject(entry) && typeof entry["command"] === "string" && entry["command"].includes("hook session-start")) {
        return { group: g, handler: h };
      }
    }
  }
  return null;
}

/**
 * codex 信任表行（hosts.md §4.4 的 spike 结论）：`[hooks.state.'<hooks.json 路径>:<事件>:<组>:<项>']`
 * + `enabled` + `trusted_hash`。事件名与哈希覆盖“该组里我们的 handler”；用户手工改动 hooks.json
 * 后下标可能漂移，此时 codex 按未信任跳过、TUI `/hooks` 可重新审查——与官方流程一致。
 */
function trustStateLines(options: SetupOptions, hookDoc: Record<string, unknown>): string[] {
  const hook = options.host.hook;
  if (!hook?.trust) return [];
  const found = findHookIndices(hookDoc, hook);
  if (!found) return [];
  const sourcePath = expandHome(hook.file, options.home ?? homedir(), options.env);
  const event = hookEventName(hook.key);
  const entry = hookEntry(options);
  const handler = (entry as { hooks: Record<string, unknown>[] }).hooks[0]!;
  const key = `${sourcePath}:${event}:${found.group}:${found.handler}`;
  const hash = commandHookHash({
    event,
    matcher: hook.matcher,
    command: handler["command"] as string,
    timeoutSec: (handler["timeout"] as number | undefined) ?? 60,
  });
  return [`[hooks.state.${tomlKey(key)}]`, "enabled = true", `trusted_hash = ${tomlString(hash)}`];
}

function planToml(
  options: SetupOptions,
  file: string,
  hookChange: FileChange | null,
): FileChange {
  const raw = readText(file);
  const extraLines: string[] = [];

  if (options.host.hook?.trust && hookChange) {
    // hooks.json 的最终形态：create/update 用 after，unchanged 用 before；conflict 时 hook 不落盘，
    // 信任表也不写（下标对不上）。
    const docText = hookChange.after ?? (hookChange.status === "unchanged" ? hookChange.before : null);
    let doc: Record<string, unknown> | null = null;
    if (docText !== null) {
      try {
        const parsed: unknown = JSON.parse(docText);
        if (isPlainObject(parsed)) doc = parsed;
      } catch {
        doc = null;
      }
    }
    if (doc) {
      const lines = trustStateLines(options, doc);
      // 相同状态键已在块外存在（用户自己审过）：不重复写，避免 TOML 重复表。
      const outside = raw?.replace(
        new RegExp(`${escapeRegExp(TOML_BEGIN)}[\\s\\S]*?${escapeRegExp(TOML_END)}`, "g"),
        "",
      );
      if (lines.length > 0 && !(outside !== null && outside !== undefined && outside.includes(lines[0]!))) {
        extraLines.push("", ...lines);
      }
    }
  }

  const block = renderTomlBlock(options);
  const withExtra =
    extraLines.length > 0 ? `${block.slice(0, block.lastIndexOf(TOML_END))}${extraLines.join("\n")}\n${TOML_END}` : block;

  if (raw !== null && tomlTablePresent(raw.replace(
    new RegExp(`${escapeRegExp(TOML_BEGIN)}[\\s\\S]*?${escapeRegExp(TOML_END)}`, "g"),
    "",
  ), options.host.mcp.key)) {
    return {
      file,
      format: "toml",
      status: "conflict",
      before: raw,
      after: null,
      detail: `[${options.host.mcp.key}] already exists outside the ck-managed block; remove it by hand first`,
    };
  }
  const out = upsertMarkedBlock(raw, TOML_BEGIN, TOML_END, withExtra);
  const change: FileChange = { file, format: "toml", status: out.status, before: raw, after: out.after };
  if (out.status !== "unchanged") change.preview = withExtra;
  if (options.host.hook?.enable_hint) {
    change.detail = `note: enable the hooks engine once with \`${options.host.hook.enable_hint}\``;
  }
  return change;
}

const RULES_TEXT = "会话开始先调用 `knowledge_status`（`reload: true`）读取团队配装。";

function renderRulesBlock(): string {
  return [RULES_BEGIN, RULES_TEXT, RULES_END].join("\n");
}

/** 在带标记的块里原地替换；没有标记则追加。返回 null 表示无需改动。 */
function upsertMarkedBlock(
  existing: string | null,
  begin: string,
  end: string,
  block: string,
): { after: string; status: "create" | "update" | "unchanged" } {
  if (existing === null) return { after: `${block}\n`, status: "create" };
  const start = existing.indexOf(begin);
  const stop = existing.indexOf(end, start + begin.length);
  if (start >= 0 && stop >= 0) {
    const current = existing.slice(start, stop + end.length);
    if (current === block) return { after: existing, status: "unchanged" };
    return { after: existing.slice(0, start) + block + existing.slice(stop + end.length), status: "update" };
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return { after: `${existing}${sep}${block}\n`, status: "update" };
}

/** 读 JSON 文件为对象；非 JSON 或非对象时给冲突描述。 */
function readJsonDoc(file: string): { doc: Record<string, unknown> | null; raw: string | null; conflict?: string } {
  const raw = readText(file);
  if (raw === null) return { doc: {}, raw };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error("root is not an object");
    return { doc: parsed, raw };
  } catch (err) {
    return { doc: null, raw, conflict: `existing file is not valid JSON: ${(err as Error).message}` };
  }
}

/** JSON 变更结果：changed=doc 被改写；unchanged=目标已一致；conflict=拒绝覆盖。 */
type JsonMerge = { status: "changed" | "unchanged" | "conflict"; detail?: string };

function mergeMcpJson(options: SetupOptions, doc: Record<string, unknown>): JsonMerge {
  const want = mcpEntry(options);
  const current = getPath(doc, options.host.mcp.key);
  if (current !== undefined) {
    if (deepEqual(current, want)) return { status: "unchanged" };
    // The entry name `ck` is owned by ck (in sync with the yaml/toml marker block semantics, acceptance-report §5.9 decided A):
    // re-running with a changed Agent updates in place, no longer reported as a conflict——"half-configured state" only happens when the entry is someone else's.
    setPath(doc, options.host.mcp.key, want);
    return { status: "changed" };
  }
  setPath(doc, options.host.mcp.key, want);
  return { status: "changed" };
}

function mergeHookJson(
  options: SetupOptions,
  doc: Record<string, unknown>,
  hook: NonNullable<HostConfig["hook"]>,
): JsonMerge {
  const want = hookEntry(options);
  const current = getPath(doc, hook.key);
  if (current !== undefined) {
    if (!Array.isArray(current)) {
      return { status: "conflict", detail: `${hook.key} exists but is not a list` };
    }
    const sameMatcher = current.filter((e) => isPlainObject(e) && e["matcher"] === hook.matcher);
    if (sameMatcher.length > 0) {
      // ck's entry is owned by ck (same reasoning as mergeMcpJson, §5.9): same matcher group already has our
      // session-start hook with different content → update in place (for convenience when changing Agent name), no conflict.
      for (const group of sameMatcher) {
        const handlers = group["hooks"];
        if (!Array.isArray(handlers)) continue;
        for (let i = 0; i < handlers.length; i++) {
          const handler = handlers[i];
          if (isPlainObject(handler) && typeof handler["command"] === "string" && handler["command"].includes("hook session-start")) {
            const wanted = (want as { hooks: unknown[] }).hooks[0];
            if (deepEqual(handler, wanted)) return { status: "unchanged" };
            handlers[i] = wanted;
            return { status: "changed" };
          }
        }
      }
      // Same matcher but no entry of ours: merge into that group
      const group = sameMatcher[0] as Record<string, unknown>;
      if (!Array.isArray(group["hooks"])) group["hooks"] = [];
      (group["hooks"] as unknown[]).push((want as { hooks: unknown[] }).hooks[0]);
      return { status: "changed" };
    }
    current.push(want);
    return { status: "changed" };
  }
  setPath(doc, hook.key, [want]);
  return { status: "changed" };
}

function planJsonMcp(options: SetupOptions, file: string): FileChange {
  const { doc, raw, conflict } = readJsonDoc(file);
  if (doc === null) return { file, format: "json", status: "conflict", before: raw, after: null, detail: conflict };
  const merge = mergeMcpJson(options, doc);
  if (merge.status === "conflict") return { file, format: "json", status: "conflict", before: raw, after: null, detail: merge.detail };
  if (merge.status === "unchanged") return { file, format: "json", status: "unchanged", before: raw, after: raw };
  return {
    file,
    format: "json",
    status: raw === null ? "create" : "update",
    before: raw,
    after: `${JSON.stringify(doc, null, 2)}\n`,
    preview: `${options.host.mcp.key}:\n${JSON.stringify(mcpEntry(options), null, 2)}`,
  };
}

function planJsonHook(options: SetupOptions, file: string, hook: NonNullable<HostConfig["hook"]>): FileChange {
  const { doc, raw, conflict } = readJsonDoc(file);
  if (doc === null) return { file, format: "json", status: "conflict", before: raw, after: null, detail: conflict };
  const merge = mergeHookJson(options, doc, hook);
  if (merge.status === "conflict") return { file, format: "json", status: "conflict", before: raw, after: null, detail: merge.detail };
  if (merge.status === "unchanged") return { file, format: "json", status: "unchanged", before: raw, after: raw };
  return {
    file,
    format: "json",
    status: raw === null ? "create" : "update",
    before: raw,
    after: `${JSON.stringify(doc, null, 2)}\n`,
    preview: `${hook.key}: [ …, ${JSON.stringify(hookEntry(options))} ]`,
  };
}

/**
 * MCP 条目与 SessionStart hook 落同一个 JSON 文件（gemini-cli 的 settings.json）时合并成一次规划——
 * 分开规划会因各自从同一份 before 出发而在 apply 时互相覆盖。
 */
function planJsonShared(options: SetupOptions, file: string, hook: NonNullable<HostConfig["hook"]>): FileChange {
  const { doc, raw, conflict } = readJsonDoc(file);
  if (doc === null) return { file, format: "json", status: "conflict", before: raw, after: null, detail: conflict };
  const details: string[] = [];
  let changed = false;
  for (const merge of [mergeMcpJson(options, doc), mergeHookJson(options, doc, hook)]) {
    if (merge.status === "conflict") {
      return { file, format: "json", status: "conflict", before: raw, after: null, detail: merge.detail };
    }
    if (merge.status === "changed") changed = true;
  }
  if (!changed) return { file, format: "json", status: "unchanged", before: raw, after: raw };
  return {
    file,
    format: "json",
    status: raw === null ? "create" : "update",
    before: raw,
    after: `${JSON.stringify(doc, null, 2)}\n`,
    preview: `${options.host.mcp.key}:\n${JSON.stringify(mcpEntry(options), null, 2)}\n${hook.key}: [ …, ${JSON.stringify(hookEntry(options))} ]`,
    detail: details.length > 0 ? details.join("\n") : undefined,
  };
}

function nestedYamlKey(dotted: string): { top: string; child: string } {
  const parts = dotted.split(".");
  if (parts.length !== 2) throw new Error(`yaml host key must be "<top>.<child>", got "${dotted}"`);
  return { top: parts[0]!, child: parts[1]! };
}

function yamlMergeToChange(
  file: string,
  raw: string | null,
  merge: { status: string; text?: string; detail?: string },
  preview?: string,
): FileChange | null {
  if (merge.status === "conflict") return { file, format: "yaml", status: "conflict", before: raw, after: null, detail: merge.detail };
  if (merge.status === "unchanged") return { file, format: "yaml", status: "unchanged", before: raw, after: raw };
  const after = merge.text!.endsWith("\n") ? merge.text! : `${merge.text}\n`;
  return { file, format: "yaml", status: raw === null ? "create" : "update", before: raw, after, preview };
}

/** hook 写 yaml 且与 mcp 不同文件（hermes 未来变体）：单独一次列表合并。 */
function planYamlHook(options: SetupOptions, file: string, hook: NonNullable<HostConfig["hook"]>): FileChange {
  const raw = readText(file);
  const { top, child } = nestedYamlKey(hook.key);
  const item = renderYamlHookItem(options);
  const merge = mergeYamlListEntry(raw ?? "", top, child, item, `hook ${hookEventCli(hook.key)}`);
  return yamlMergeToChange(file, raw, merge, `${top}.${child}: [ …, ${item.join(" ")} ]`)!;
}

/**
 * mcp 与 hook 落同一个 YAML 文件（hermes `config.yaml`）：在同一份文本上顺次做两次结构
 * 合并——`mcp_servers.ck` 映射条目 + `hooks.pre_llm_call` 列表项，任一步冲突则整份不动。
 */
function planYamlShared(options: SetupOptions, file: string, hook: NonNullable<HostConfig["hook"]>): FileChange {
  const raw = readText(file);
  const mk = nestedYamlKey(options.host.mcp.key);
  const hk = nestedYamlKey(hook.key);
  const mcpItem = renderYamlMcpEntry(options);
  const hookItem = renderYamlHookItem(options);
  const m1 = mergeYamlMapEntry(raw ?? "", mk.top, mk.child, mcpItem);
  if (m1.status === "conflict") return { file, format: "yaml", status: "conflict", before: raw, after: null, detail: m1.detail };
  const m2 = mergeYamlListEntry(m1.text, hk.top, hk.child, hookItem, `hook ${hookEventCli(hook.key)}`);
  if (m2.status === "conflict") return { file, format: "yaml", status: "conflict", before: raw, after: null, detail: m2.detail };
  if (m1.status === "unchanged" && m2.status === "unchanged") {
    return { file, format: "yaml", status: "unchanged", before: raw, after: raw };
  }
  const after = m2.text.endsWith("\n") ? m2.text : `${m2.text}\n`;
  const preview = [`${mk.top}.${mk.child} 入口：`, ...mcpItem.map((l) => `  ${l}`), `${hk.top}.${hk.child} 追加：`, ...hookItem.map((l) => `  ${l}`)].join("\n");
  return { file, format: "yaml", status: raw === null ? "create" : "update", before: raw, after, preview };
}

/**
 * 与 hermes `script_mtime_iso` 同串：UTC、整秒不带小数、否则 6 位微秒、`Z` 结尾。
 * hermes 拿它和当前 mtime 做字符串比较判「批准后脚本是否改过」，格式差一位就会误报。
 * 微秒取法照 CPython `datetime.fromtimestamp`：秒 + 1e-9·纳秒 的 double，再 round-half-even。
 */
function hermesMtimeIso(file: string): string {
  const ns = statSync(file, { bigint: true }).mtimeNs;
  const t = Number(ns / 1_000_000_000n) + 1e-9 * Number(ns % 1_000_000_000n);
  let sec = Math.floor(t);
  const x = (t - sec) * 1e6;
  let us = Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
  if (us >= 1e6) {
    us -= 1e6;
    sec += 1;
  }
  const base = new Date(sec * 1000).toISOString().slice(0, 19);
  return us === 0 ? `${base}Z` : `${base}.${String(us).padStart(6, "0")}Z`;
}

/**
 * hermes `shell-hooks-allowlist.json`（hosts.md §4.6）：根是 `{"approvals": [...]}`，
 * hermes 按 (event, command) 精确匹配，存在即视为已批准，不重复追加；根上的其他键原样保留。
 * 根不是这个形状时 hermes 自己也按不可读处理（hook 不注册），这里报 conflict 不覆盖。
 */
function planConsentFile(options: SetupOptions, file: string, hook: NonNullable<HostConfig["hook"]>): FileChange {
  const raw = readText(file);
  let doc: Record<string, unknown> = {};
  let approvals: unknown[] = [];
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error("root is not an object");
      const list = parsed["approvals"];
      if (list !== undefined && !Array.isArray(list)) throw new Error("`approvals` is not a list");
      doc = parsed;
      approvals = list ?? [];
    } catch (err) {
      return {
        file,
        format: "json",
        status: "conflict",
        before: raw,
        after: null,
        detail: `existing allowlist is not {"approvals": [...]}: ${(err as Error).message}`,
      };
    }
  }
  const event = hookEventName(hook.key);
  const command = hookCommand(options);
  if (approvals.some((e) => isPlainObject(e) && e["event"] === event && e["command"] === command)) {
    return { file, format: "json", status: "unchanged", before: raw, after: raw };
  }
  const entry: Record<string, unknown> = { event, command, approved_at: new Date().toISOString() };
  try {
    entry["script_mtime_at_approval"] = hermesMtimeIso(options.ckEntry);
  } catch {
    // ckEntry 不可 stat 时略过——批准匹配不依赖它，hermes 只是报不出「脚本未改」
  }
  return {
    file,
    format: "json",
    status: raw === null ? "create" : "update",
    before: raw,
    after: `${JSON.stringify({ ...doc, approvals: [...approvals, entry] }, null, 2)}\n`,
    preview: `approvals: [ …, ${JSON.stringify(entry)} ]`,
  };
}

function planYaml(options: SetupOptions, file: string): FileChange {
  const raw = readText(file);
  const block = renderYamlBlock(options);
  // 标记块之外已存在同名 id → 不重复插
  if (raw !== null) {
    const outside = raw.replace(new RegExp(`${escapeRegExp(YAML_BEGIN)}[\\s\\S]*?${escapeRegExp(YAML_END)}`, "g"), "");
    if (new RegExp(`^\\s*-?\\s*id:\\s*['"]?${escapeRegExp(options.host.mcp.key)}['"]?\\s*$`, "m").test(outside)) {
      return {
        file,
        format: "yaml",
        status: "conflict",
        before: raw,
        after: null,
        detail: `id ${options.host.mcp.key} already exists outside the ck-managed block; remove it by hand first`,
      };
    }
  }
  const out = upsertMarkedBlock(raw, YAML_BEGIN, YAML_END, block);
  const change: FileChange = { file, format: "yaml", status: out.status, before: raw, after: out.after };
  if (out.status !== "unchanged") change.preview = block;
  return change;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function planSetup(options: SetupOptions): SetupPlan {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const changes: FileChange[] = [];

  // TOML 宿主的 config.toml 同时承载 mcp 条目与 hook 信任状态：hook 规划先行，下标喂给 planToml。
  const hook = options.host.hook;
  const mcpFile = expandHome(options.host.mcp.file, home, env);
  const hookFile = hook ? expandHome(hook.file, home, env) : null;
  // mcp 与 hook 写同一个 JSON 文件（gemini-cli）：合并成一条变更，避免 apply 互相覆盖。
  const sharedJson =
    hook !== null &&
    hook.format === "json" &&
    !options.host.mcp.insert &&
    options.host.mcp.format === "json" &&
    mcpFile === hookFile;
  // 同一个 YAML 文件（hermes `config.yaml`）：同样合并成一条变更。
  const sharedYaml =
    hook !== null &&
    hook.format === "yaml" &&
    !options.host.mcp.insert &&
    options.host.mcp.format === "yaml" &&
    mcpFile === hookFile;
  const hookChange =
    hook?.format === "json" && !sharedJson
      ? planJsonHook(options, hookFile!, hook)
      : hook?.format === "yaml" && !sharedYaml
        ? planYamlHook(options, hookFile!, hook)
        : null;

  if (sharedJson) {
    changes.push(planJsonShared(options, mcpFile, hook));
  } else if (sharedYaml) {
    changes.push(planYamlShared(options, mcpFile, hook));
  } else if (options.host.mcp.insert) {
    if (options.host.mcp.format !== "yaml") {
      throw new Error(`host ${options.host.name} declares insert with format ${options.host.mcp.format}; only yaml is implemented`);
    }
    changes.push(planYaml(options, mcpFile));
  } else if (options.host.mcp.format === "toml") {
    changes.push(planToml(options, mcpFile, hookChange));
  } else {
    if (options.host.mcp.file === "") throw new Error(`host ${options.host.name} declares no MCP config file; use \`ck setup --host generic\` to print a manual snippet`);
    if (options.host.mcp.format !== "json") {
      throw new Error(`host ${options.host.name} declares format ${options.host.mcp.format}; only json and yaml are implemented`);
    }
    changes.push(planJsonMcp(options, mcpFile));
  }

  if (hookChange) changes.push(hookChange);

  // hook 批准表（hermes `shell-hooks-allowlist.json`）：hook 条目本身冲突时不批准——
  // 批准一个没接线的命令只会误导后续排查。
  if (hook?.consent) {
    const hookChangeConflict =
      hookChange?.status === "conflict" || changes.some((c) => c.status === "conflict");
    if (!hookChangeConflict) {
      changes.push(planConsentFile(options, expandHome(hook.consent.file, home, env), hook));
    }
  }

  if (options.rules) {
    if (!options.host.rules_file) throw new Error(`host ${options.host.name} declares no rules file; add rules_file to its host.json`);
    const file = expandHome(options.host.rules_file, home, env);
    const raw = readText(file);
    const out = upsertMarkedBlock(raw, RULES_BEGIN, RULES_END, renderRulesBlock());
    changes.push({
      file,
      format: "markdown",
      status: out.status,
      before: raw,
      after: out.after,
      ...(out.status !== "unchanged" ? { preview: renderRulesBlock() } : {}),
    });
  }

  return { changes, exitCode: changes.some((c) => c.status === "conflict") ? 1 : 0 };
}

/**
 * 落盘：非 create/update 跳过；改已有文件先备份 `.bak`。返回写过的文件。
 * 一次执行要么全写要么不写：任一文件是 conflict 就一个都不写，免得宿主停在半接入状态
 * （hook 在跑而 MCP 条目是别人的；或 MCP 指向新 Agent、hook 还在注入旧 Agent 的配装）。
 */
export function applyPlan(plan: SetupPlan): string[] {
  const written: string[] = [];
  if (plan.changes.some((c) => c.status === "conflict")) return written;
  for (const change of plan.changes) {
    if (change.status !== "create" && change.status !== "update") continue;
    if (change.after === null) continue;
    mkdirSync(dirname(change.file), { recursive: true });
    if (change.before !== null) writeFileSync(`${change.file}.bak`, change.before);
    const tmp = `${change.file}.ck-${process.pid}.tmp`;
    writeFileSync(tmp, change.after);
    renameSync(tmp, change.file);
    written.push(change.file);
  }
  return written;
}
