import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ResolveSkill } from "@cinlan/knowledge-sdk";

/**
 * skill 物化（loadout.md §7）：
 * - 平铺到 `<skill root>/<name>/`，只动带 `.cinlan-knowledge.json` 标记的目录；
 * - 标记里的 `agents[]` 做引用计数，空了才删目录；
 * - 内容以资产版本内容为准，`content_hash` 相同就跳过；
 * - 先写临时目录再整体改名，落点做路径二次校验。
 */

export const MARKER_FILE = ".cinlan-knowledge.json";

interface Marker {
  asset_id: string;
  version: number;
  content_hash: string;
  agents: string[];
  materialized_at: string;
}

export interface SkillSource {
  /** 取 skill 的一个版本：`SKILL.md` 内容与附属文件清单。 */
  read: (assetId: string, version: number) => Promise<{ files: { path: string; bytes: number }[]; content: string }>;
  /** 取单个附属文件的原始字节；版本必须显式给出，避免中途发布新版导致内容错配。 */
  readFile: (assetId: string, version: number, path: string) => Promise<Buffer>;
}

export interface MaterializeOptions {
  skillRoot: string;
  agentId: string;
  skills: ResolveSkill[];
  source: SkillSource;
  /** 物化时间戳；测试可固定。 */
  now?: () => string;
}

export interface MaterializeResult {
  written: string[];
  skipped: { name: string; reason: "conflict" | "unchanged" }[];
  removed: string[];
}

/**
 * 校验并归一化相对路径：拒绝绝对路径、盘符、`..`，
 * 解析后的落点必须仍在目标文件内。hub 入库时已验过，这里是第二道。
 */
function safeJoin(root: string, relPath: string): string {
  if (relPath === "" || isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`unsafe path: ${relPath}`);
  }
  const parts = relPath.split(/[\\/]+/);
  for (const part of parts) if (part === ".." || part === "") throw new Error(`unsafe path: ${relPath}`);
  const target = resolve(root, ...parts);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`unsafe path: ${relPath}`);
  return target;
}

function readMarker(dir: string): Marker | null {
  const file = join(dir, MARKER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Marker>;
    if (typeof parsed.asset_id !== "string" || !Array.isArray(parsed.agents)) return null;
    return {
      asset_id: parsed.asset_id,
      version: typeof parsed.version === "number" ? parsed.version : 0,
      content_hash: typeof parsed.content_hash === "string" ? parsed.content_hash : "",
      agents: parsed.agents.filter((a): a is string => typeof a === "string"),
      materialized_at: typeof parsed.materialized_at === "string" ? parsed.materialized_at : "",
    };
  } catch {
    return null;
  }
}

function hashOf(content: string, extra: { path: string; bytes: Buffer }[]): string {
  const h = createHash("sha256");
  h.update(content, "utf8");
  for (const f of extra.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update("\u0000" + f.path);
    h.update(f.bytes);
  }
  return h.digest("hex");
}

export async function materializeSkills(options: MaterializeOptions): Promise<MaterializeResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const root = options.skillRoot;
  const result: MaterializeResult = { written: [], skipped: [], removed: [] };
  mkdirSync(root, { recursive: true });

  const wanted = new Map(options.skills.map((s) => [s.name, s]));

  // 1. 先处理已存在的带标记目录：退出引用、清理过期项。
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const marker = readMarker(dir);
    if (!marker) continue;
    const target = wanted.get(entry.name);
    if (target !== undefined && target.asset_id === marker.asset_id) continue; // 下面统一处理
    // 本 Agent 不再使用（或因同名不同资产而冲突）：只退出自己
    if (!marker.agents.includes(options.agentId)) continue;
    const rest = marker.agents.filter((a) => a !== options.agentId);
    if (rest.length > 0) {
      writeMarker(dir, { ...marker, agents: rest });
    } else {
      rmSync(dir, { recursive: true, force: true });
      result.removed.push(entry.name);
    }
  }

  // 2. 逐个物化。
  for (const skill of wanted.values()) {
    const dir = join(root, skill.name);
    const existing = readMarker(dir);

    if (existsSync(dir) && existing === null) {
      // 同名目录不是我们写的：不覆盖，报冲突
      result.skipped.push({ name: skill.name, reason: "conflict" });
      continue;
    }
    if (existing !== null && existing.asset_id !== skill.asset_id) {
      // 另一个团队的同名 skill：不覆盖，报冲突
      result.skipped.push({ name: skill.name, reason: "conflict" });
      continue;
    }
    if (existing !== null && existing.version > skill.version) {
      // 版本分歧：目录只有一份，保留版本号大的
      result.skipped.push({ name: skill.name, reason: "unchanged" });
      continue;
    }

    const read = await options.source.read(skill.asset_id, skill.version);
    const extra: { path: string; bytes: Buffer }[] = [];
    for (const f of read.files) {
      extra.push({ path: f.path, bytes: await options.source.readFile(skill.asset_id, skill.version, f.path) });
    }
    const contentHash = hashOf(read.content, extra);

    if (existing !== null && existing.content_hash === contentHash && existing.version === skill.version) {
      if (!existing.agents.includes(options.agentId)) {
        writeMarker(dir, { ...existing, agents: [...existing.agents, options.agentId] });
      }
      result.skipped.push({ name: skill.name, reason: "unchanged" });
      continue;
    }

    // 原子写：同级临时目录 → 改名。目标已存在先挪开，改名失败再还原。
    const tmp = join(root, `.${skill.name}.${process.pid}.${Date.now()}.tmp`);
    mkdirSync(tmp, { recursive: true });
    try {
      writeFileSync(safeJoin(tmp, "SKILL.md"), read.content, "utf8");
      for (const f of extra) {
        const dest = safeJoin(tmp, f.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.bytes);
      }
      writeMarker(tmp, {
        asset_id: skill.asset_id,
        version: skill.version,
        content_hash: contentHash,
        agents: [options.agentId],
        materialized_at: now(),
      });
      const backup = join(root, `.${skill.name}.${process.pid}.bak`);
      const hadOld = existsSync(dir);
      if (hadOld) renameSync(dir, backup);
      try {
        renameSync(tmp, dir);
      } catch (err) {
        if (hadOld) renameSync(backup, dir);
        throw err;
      }
      if (hadOld) rmSync(backup, { recursive: true, force: true });
      result.written.push(skill.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  return result;
}

function writeMarker(dir: string, marker: Marker): void {
  writeFileSync(join(dir, MARKER_FILE), JSON.stringify(marker, null, 2) + "\n");
}
