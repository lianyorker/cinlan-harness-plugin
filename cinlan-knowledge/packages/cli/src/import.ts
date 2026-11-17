import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import type { SkillFile } from "@cinlan/knowledge-sdk";
import { KnowledgeRpcError } from "@cinlan/knowledge-mcp";
import type { ResolvedConfig } from "./config.js";
import type { HostConfig } from "./hosts.js";
import { callEnvelope, PrepareError } from "./prepare.js";
import { MARKER_FILE } from "./skills.js";

/**
 * `ck import --source <h>`（hosts.md §8、data-model.md §9）：把本机宿主的 skill 目录
 * 逐个登记成调用者在某团队名下的 private skill 资产。幂等在 hub（asset/import），
 * 客户端不算 hash，只管把目录快照原样送上去。
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TITLE_MAX = 120;
const SUMMARY_MAX = 300;
/** 每条共尝试 3 次，两次重试前各退避一档（decisions.md O-28）。 */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000];
/** 条目之间的固定间隔（hosts.md §8「逐条顺序提交并限速」）。 */
const ITEM_INTERVAL_MS = 100;

// ------------------------------------------------------------------ 扫描

export interface ScanContext {
  /** `<workspace>` 占位符的展开值。 */
  workspace: string;
  /** `~` 的展开值。 */
  home: string;
  env: NodeJS.ProcessEnv;
}

/** `import_scan` 条目 → 实际目录。`$VAR` / `%VAR%` 未定义或展开后不存在的目录跳过并记 note。 */
export function expandScanDirs(
  scan: string[],
  ctx: ScanContext,
): { dirs: string[]; notes: string[] } {
  const dirs: string[] = [];
  const notes: string[] = [];
  for (const entry of scan) {
    let p = entry;
    let miss: string | null = null;
    const fromEnv = (token: string, name: string): string => {
      const v = ctx.env[name];
      if (v === undefined || v === "") miss = `${token} 未设置`;
      return v ?? "";
    };
    if (p.startsWith("~")) p = ctx.home + p.slice(1);
    p = p.replaceAll("<workspace>", ctx.workspace);
    p = p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, fromEnv);
    // win32 的声明用 %VAR%（hermes：%LOCALAPPDATA%/hermes/skills）
    p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, fromEnv);
    if (miss !== null) {
      notes.push(`${entry} → 跳过（${miss}）`);
      continue;
    }
    const abs = resolve(p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      notes.push(`${entry} → 跳过（目录不存在：${abs}）`);
      continue;
    }
    dirs.push(abs);
  }
  return { dirs, notes };
}

export interface SkillCandidate {
  /** 目录绝对路径，随请求作 `import_path` 上报。 */
  dir: string;
  name: string;
  title: string;
  summary: string;
  content: string;
  files: SkillFile[];
}

export interface SkippedDir {
  dir: string;
  reason: "externalized" | "bad-frontmatter" | "duplicate" | "read-error";
  detail?: string;
}

/**
 * 块标量（`>` / `|`，可带 `+` `-`）的正文：去掉公共缩进；`>` 把相邻行折成一行、空行才换行，
 * `|` 原样保留换行。首尾空白一律去掉，收尾符不区分。
 */
function blockScalar(body: string[], folded: boolean): string {
  const filled = body.filter((l) => l.trim() !== "");
  if (filled.length === 0) return "";
  const indent = Math.min(...filled.map((l) => l.length - l.trimStart().length));
  const lines = body.map((l) => l.slice(indent).trimEnd());
  if (!folded) return lines.join("\n").trim();
  let out = "";
  let breaks = 0;
  for (const line of lines) {
    if (line === "") {
      breaks += 1;
      continue;
    }
    if (out !== "") out += breaks > 0 ? "\n".repeat(breaks) : " ";
    out += line;
    breaks = 0;
  }
  return out;
}

/**
 * 顶层 `---` 围栏里的 `name` / `description` 标量；没有围栏返回 null。
 * 逐行 `key: value` 加块标量（`>` / `|`），与 hub 收件时用的 core `parseSkillFrontmatter` 同一套读法——
 * 两边读出来的不一样，本该在扫描时跳过的目录会被送上去再被拒。改一边要同步另一边。
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = text.slice(3, end).replace(/^\r?\n/, "");
  const fields: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    let value = m[2]!.trim();
    const scalar = /^([>|])[+-]?$/.exec(value);
    if (scalar) {
      // 正文是后面连续的缩进行，空行算在内；遇到顶格行结束
      const body: string[] = [];
      while (i + 1 < lines.length && /^(?:[ \t]|$)/.test(lines[i + 1]!)) body.push(lines[++i]!);
      value = blockScalar(body, scalar[1] === ">");
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[m[1]!] = value;
  }
  return { name: fields["name"], description: fields["description"] };
}

/** `1,3,5-7` → 选中下标（0 基）；`a/all` → "all"；空 / `s/skip/n/none` → "none"；其它 → null。 */
export function parseSelection(input: string, count: number): number[] | "all" | "none" | null {
  const s = input.trim().toLowerCase();
  if (s === "a" || s === "all") return "all";
  if (s === "" || s === "s" || s === "skip" || s === "n" || s === "none") return "none";
  const picked = new Set<number>();
  for (const tok of s.split(/[\s,]+/)) {
    if (tok === "") continue;
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (lo < 1 || hi > count || lo > hi) return null;
    for (let i = lo; i <= hi; i++) picked.add(i - 1);
  }
  return picked.size > 0 ? [...picked].sort((a, b) => a - b) : null;
}

function readFiles(dir: string, base: string): SkillFile[] {
  const out: SkillFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...readFiles(abs, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (rel === "SKILL.md" || rel === MARKER_FILE) continue;
    const buf = readFileSync(abs);
    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      // 二进制走 base64
    }
    out.push(
      text === null
        ? { path: rel, encoding: "base64", content: buf.toString("base64") }
        : { path: rel, encoding: "utf8", content: text },
    );
  }
  return out;
}

/**
 * 每个扫描目录取一级子目录：`SKILL.md` 存在且目录不带物化标记才算候选；
 * frontmatter 缺 / `name` 非 slug / `description` 空 → skipped(bad-frontmatter)。
 * 同名候选按扫描顺序先到先得，后者记 duplicate。
 */
export function scanSkills(dirs: string[]): { candidates: SkillCandidate[]; skipped: SkippedDir[] } {
  const candidates: SkillCandidate[] = [];
  const skipped: SkippedDir[] = [];
  const seenNames = new Set<string>();
  const seenDirs = new Set<string>();
  for (const dir of dirs) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const sub = join(dir, entry.name);
      const skillMd = join(sub, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      if (existsSync(join(sub, MARKER_FILE))) {
        skipped.push({ dir: sub, reason: "externalized" });
        continue;
      }
      try {
        const content = readFileSync(skillMd, "utf8");
        const fm = parseFrontmatter(content);
        const name = fm?.name;
        if (fm === null || name === undefined || !SLUG.test(name) || fm.description === undefined || fm.description === "") {
          skipped.push({ dir: sub, reason: "bad-frontmatter", detail: "frontmatter 缺 name/description 或 name 不是 slug" });
          continue;
        }
        if (seenNames.has(name)) {
          skipped.push({ dir: sub, reason: "duplicate", detail: `name "${name}" 已被 ${candidates.find((c) => c.name === name)?.dir ?? "前项"} 占用` });
          continue;
        }
        seenNames.add(name);
        candidates.push({
          dir: sub,
          name,
          title: name.slice(0, TITLE_MAX),
          summary: fm.description.slice(0, SUMMARY_MAX),
          content,
          files: readFiles(sub, ""),
        });
      } catch (err) {
        skipped.push({ dir: sub, reason: "read-error", detail: (err as Error).message });
      }
    }
  }
  return { candidates, skipped };
}

// ------------------------------------------------------------------ 提交

export interface ImportOptions {
  config: ResolvedConfig;
  host: HostConfig;
  workspace?: string;
  /** `--team <slug>`；缺省时看 auth/verify 的 teams：唯一自动选，多个报错列出。 */
  team?: string;
  yes?: boolean;
  update?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 缺省走 process.stdin/stdout 的 TTY 判定与 readline。 */
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  out?: (line: string) => void;
}

export interface ItemResult {
  name: string;
  dir: string;
  outcome: "success" | "failed" | "skipped";
  status?: string;
  detail?: string;
}

export interface ImportReport {
  team: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  items: ItemResult[];
  scanSkipped: SkippedDir[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
}

/** 失败原因：hub 的说明加逐条 `issues`；错误码已在 status 里，这里不再带一遍。没有说明返回 undefined。 */
function failureDetail(err: unknown): string | undefined {
  if (!(err instanceof KnowledgeRpcError)) return (err as Error).message;
  const prefix = `${err.code}: `;
  const parts = err.message.startsWith(prefix) ? [err.message.slice(prefix.length)] : [];
  const issues = err.data["issues"];
  if (Array.isArray(issues)) parts.push(...issues.filter((i): i is string => typeof i === "string"));
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function failedItem(c: SkillCandidate, status: string, err: unknown): ItemResult {
  const detail = failureDetail(err);
  return { name: c.name, dir: c.dir, outcome: "failed", status, ...(detail !== undefined ? { detail } : {}) };
}

async function submitOne(
  opts: ImportOptions,
  team: string,
  c: SkillCandidate,
): Promise<ItemResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const body: Record<string, unknown> = {
    team,
    name: c.name,
    title: c.title,
    content: c.content,
    summary: c.summary,
    files: c.files,
    host: opts.host.name,
    import_path: c.dir,
    ...(opts.update ? { on_conflict: "new_version" } : {}),
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await callEnvelope({
        hub: opts.config.hub!,
        key: opts.config.key!,
        action: "asset/import",
        body,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
      });
      const status = (data as { status?: string }).status ?? "unknown";
      if (status === "created" || status === "updated" || status === "unchanged") {
        return { name: c.name, dir: c.dir, outcome: "success", status };
      }
      if (status === "conflict") {
        return opts.update
          ? { name: c.name, dir: c.dir, outcome: "failed", status: "conflict-under-review-mode", detail: "审批模式下不代发审批单；改走 asset/update" }
          : { name: c.name, dir: c.dir, outcome: "skipped", status: "conflict", detail: "内容不同；加 --update 出新版本" };
      }
      return { name: c.name, dir: c.dir, outcome: "failed", status, detail: "unrecognized status" };
    } catch (err) {
      const retryable =
        (err instanceof PrepareError && err.code === "UNAVAILABLE") ||
        (err instanceof KnowledgeRpcError && err.code === "RATE_LIMITED");
      const code = err instanceof KnowledgeRpcError || err instanceof PrepareError ? err.code : "INTERNAL";
      // 重试用尽也按原错误码记（429 是 RATE_LIMITED，不并进 UNAVAILABLE）
      if (!retryable || attempt === MAX_ATTEMPTS) return failedItem(c, code, err);
      const retryAfterSec =
        err instanceof KnowledgeRpcError && typeof err.data?.["retry_after"] === "number"
          ? (err.data["retry_after"] as number) * 1000
          : 0;
      await sleep(Math.max(RETRY_BACKOFF_MS[attempt - 1]!, retryAfterSec));
    }
  }
  return { name: c.name, dir: c.dir, outcome: "failed", status: "INTERNAL", detail: "unreachable" };
}

async function resolveTeam(opts: ImportOptions): Promise<string> {
  const data = await callEnvelope({
    hub: opts.config.hub!,
    key: opts.config.key!,
    action: "auth/verify",
    body: {},
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  const teams = ((data as { teams?: { team: string; role?: string }[] }).teams ?? []).map((t) => t.team);
  if (opts.team !== undefined) {
    if (!teams.includes(opts.team)) {
      throw new PrepareError("FORBIDDEN", `--team ${opts.team} 不是你的团队（成员：${teams.join(", ") || "无"}）`);
    }
    return opts.team;
  }
  if (teams.length === 0) throw new PrepareError("FORBIDDEN", "你不属于任何团队；先让管理员把你加进团队");
  if (teams.length === 1) return teams[0]!;
  throw new PrepareError(
    "INVALID_ARGUMENT",
    `你属于多个团队（${teams.join(", ")}）；用 --team <slug> 指定导入到哪个团队`,
  );
}

export async function runImport(opts: ImportOptions): Promise<ImportReport> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ctx: ScanContext = {
    workspace: opts.workspace ?? process.cwd(),
    home: homedir(),
    env: process.env,
  };
  const scan = opts.host.import_scan ?? [];
  const { dirs, notes } = expandScanDirs(scan, ctx);
  for (const n of notes) out(`scan note: ${n}`);
  const { candidates, skipped } = scanSkills(dirs);
  for (const s of skipped) {
    out(`  skip  ${s.dir} (${s.reason}${s.detail !== undefined ? `: ${s.detail}` : ""})`);
  }

  // 扫描期跳过的目录也是 skipped（data-model.md §9），各出口的合计都把它算进去
  const found = candidates.length + skipped.length;

  if (candidates.length === 0) {
    out("no candidate skills found");
    return { team: "", total: found, success: 0, failed: 0, skipped: found, items: [], scanSkipped: skipped };
  }

  if (opts.dryRun) {
    out(`dry run: ${candidates.length} candidate(s), nothing sent`);
    candidates.forEach((c, i) => out(`  ${String(i + 1).padStart(2)}) ${c.name} — ${c.dir}`));
    return {
      team: "",
      total: found,
      success: 0,
      failed: 0,
      skipped: found,
      items: candidates.map((c) => ({ name: c.name, dir: c.dir, outcome: "skipped", status: "dry-run" })),
      scanSkipped: skipped,
    };
  }

  // 选择：--yes 全选；TTY 交互列出；非 TTY 且没 --yes 直接拒绝（不写）
  let picked: SkillCandidate[];
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (opts.yes) {
    picked = candidates;
  } else if (!interactive) {
    throw new PrepareError(
      "INVALID_ARGUMENT",
      `发现 ${candidates.length} 个候选但非交互终端；用 --yes 全部导入，或 --dry-run 先看清单`,
    );
  } else {
    const ask = opts.ask ?? defaultAsk;
    out(`found ${candidates.length} candidate skill(s):`);
    candidates.forEach((c, i) => out(`  ${String(i + 1).padStart(2)}) ${c.name} — ${c.dir}`));
    for (;;) {
      const answer = await ask("import? [a]ll / [s]kip / numbers (e.g. 1,3,5-7): ");
      const sel = parseSelection(answer, candidates.length);
      if (sel === "all") {
        picked = candidates;
        break;
      }
      if (sel === "none") {
        picked = [];
        break;
      }
      if (sel !== null) {
        picked = sel.map((i) => candidates[i]!);
        break;
      }
      out(`无法解析 "${answer.trim()}"；输入 a / s / 序号或区间`);
    }
  }
  if (picked.length === 0) {
    out("nothing selected");
    return { team: "", total: found, success: 0, failed: 0, skipped: found, items: [], scanSkipped: skipped };
  }

  const team = await resolveTeam(opts);
  out(`import → team ${team}`);

  const sleep = opts.sleep ?? defaultSleep;
  const items: ItemResult[] = [];
  for (const [i, c] of picked.entries()) {
    if (i > 0) await sleep(ITEM_INTERVAL_MS);
    const r = await submitOne(opts, team, c);
    items.push(r);
    const mark = r.outcome === "success" ? "ok  " : r.outcome === "skipped" ? "skip" : "fail";
    out(`  ${mark}  ${c.name} (${r.status ?? ""}${r.detail !== undefined ? `: ${r.detail}` : ""})`);
  }
  const success = items.filter((i) => i.outcome === "success").length;
  const failed = items.filter((i) => i.outcome === "failed").length;
  // 没提交的都算 skipped：conflict、交互里没选中的候选、扫描期跳过的目录
  const skippedN = found - success - failed;
  out(`total ${found} · success ${success} · failed ${failed} · skipped ${skippedN}`);
  return { team, total: found, success, failed, skipped: skippedN, items, scanSkipped: skipped };
}
