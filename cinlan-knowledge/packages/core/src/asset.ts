import type {
  AclPermission,
  AclSubjectType,
  Asset,
  AssetSource,
  AssetStatus,
  AssetType,
  AssetVersion,
  MemoryLayer,
  SkillFile,
  Visibility,
} from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import {
  accessibleParams,
  ACCESSIBLE_SQL,
  canManage,
  manageVia,
  readVia,
  requireManage,
  requireRead,
} from "./access.js";
import type { Principal } from "./access.js";
import { alreadyExists, forbidden, invalid, notFound, versionConflict } from "./errors.js";
import { newId, nowIso, sha256Hex, stableStringify } from "./ids.js";
import { getUserById, requireTeamRole, resolveTeam, resolveUserRef } from "./meta.js";
import { makePage, readPage } from "./paging.js";
import { withTx } from "./tx.js";
import { optOneOf, optString, optTags, reqString, Validator } from "./validate.js";

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export const LIMITS = {
  title: 120,
  summary: 300,
  content: 256 * 1024,
  file: 5 * 1024 * 1024,
  skill_files: 200,
  skill_total: 20 * 1024 * 1024,
  skill_path: 200,
} as const;

const ASSET_TYPES: readonly AssetType[] = ["memory", "skill", "wiki", "codegraph"];
const VISIBILITIES: readonly Visibility[] = ["private", "team", "restricted", "agent"];
const STATUSES: readonly AssetStatus[] = ["draft", "active", "deprecated", "archived"];
const LAYERS: readonly MemoryLayer[] = ["core", "profile", "atom"];
export const ACL_SUBJECTS: readonly AclSubjectType[] = ["user", "role", "agent"];
export const ACL_PERMISSIONS: readonly AclPermission[] = ["read", "manage"];

/** 相对路径、`/` 分隔、无 `..` / 反斜杠 / 盘符 / 前导 `/`、≤200 字符。 */
export function validSkillPath(path: string): boolean {
  if (path === "" || path.length > LIMITS.skill_path) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function decodeFile(file: SkillFile): Buffer {
  if (file.encoding === "utf8") return Buffer.from(file.content, "utf8");
  if (file.encoding === "base64") return Buffer.from(file.content, "base64");
  throw invalid("invalid argument", [`file ${file.path}: encoding must be utf8 | base64`]);
}

export interface NormalizedFiles {
  path: string;
  bytes: number;
  sha256: string;
  data: Buffer;
}

/** 文件数量、单文件大小、总量、路径都按 data-model §2 校验。 */
export function normalizeFiles(v: Validator, files: SkillFile[] | undefined): NormalizedFiles[] {
  if (!files || files.length === 0) return [];
  if (files.length > LIMITS.skill_files) v.issue(`files exceed ${LIMITS.skill_files} entries`);
  const seen = new Set<string>();
  const out: NormalizedFiles[] = [];
  let total = 0;
  for (const file of files) {
    if (typeof file.path !== "string" || !validSkillPath(file.path)) {
      v.issue(`invalid file path: ${String(file.path)}`);
      continue;
    }
    if (seen.has(file.path)) {
      v.issue(`duplicate file path: ${file.path}`);
      continue;
    }
    seen.add(file.path);
    if (file.path === "SKILL.md") {
      v.issue("SKILL.md belongs in content, not files");
      continue;
    }
    let data: Buffer;
    try {
      data = decodeFile(file);
    } catch {
      v.issue(`file ${file.path}: encoding must be utf8 | base64`);
      continue;
    }
    if (data.length > LIMITS.file) v.issue(`file ${file.path} exceeds ${LIMITS.file} bytes`);
    total += data.length;
    out.push({ path: file.path, bytes: data.length, sha256: sha256Hex(data), data });
  }
  if (total > LIMITS.skill_total) v.issue(`skill files exceed ${LIMITS.skill_total} bytes in total`);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
 * SKILL.md 必须有 YAML frontmatter，`name` 等于 asset.name，`description` 非空。
 * 只解析顶层 `key: value` 标量与块标量（`>` / `|`）——skill 的 frontmatter 是平铺的，不需要完整 YAML。
 */
export function parseSkillFrontmatter(markdown: string): { name: string; description: string } | null {
  if (!markdown.startsWith("---")) return null;
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = markdown.slice(3, end).replace(/^\r?\n/, "");
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
  if (fields["name"] === undefined || fields["description"] === undefined || fields["description"] === "") return null;
  return { name: fields["name"], description: fields["description"] };
}

export function contentHash(input: {
  type: AssetType;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  layer: MemoryLayer | null;
  expires_at: string | null;
  files: { path: string; sha256: string }[];
}): string {
  if (input.type === "memory") {
    return sha256Hex(
      stableStringify({
        title: input.title,
        summary: input.summary,
        content: input.content,
        tags: input.tags,
        layer: input.layer,
        expires_at: input.expires_at,
      }),
    );
  }
  return sha256Hex(
    stableStringify({
      title: input.title,
      summary: input.summary,
      content: input.content,
      tags: input.tags,
      files: input.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    }),
  );
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

interface AssetRow {
  seq: number;
  id: string;
  team_id: string;
  type: string;
  name: string | null;
  title: string;
  summary: string;
  layer: string | null;
  tags: string;
  owner_user_id: string;
  visibility: string;
  status: string;
  current_version: number;
  expires_at: string | null;
  usage_count: number;
  last_used_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  asset_id: string;
  version: number;
  state: string;
  base_version: number | null;
  title: string;
  summary: string;
  content: string;
  content_hash: string;
  author_user_id: string;
  change_note: string;
  created_at: string;
}

export function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    team_id: row.team_id,
    type: row.type as AssetType,
    name: row.name,
    title: row.title,
    summary: row.summary,
    layer: row.layer as MemoryLayer | null,
    tags: JSON.parse(row.tags) as string[],
    owner_user_id: row.owner_user_id,
    visibility: row.visibility as Visibility,
    status: row.status as AssetStatus,
    current_version: row.current_version,
    expires_at: row.expires_at,
    usage_count: row.usage_count,
    last_used_at: row.last_used_at,
    source: JSON.parse(row.source) as Asset["source"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toVersion(row: VersionRow): AssetVersion {
  return {
    asset_id: row.asset_id,
    version: row.version,
    state: row.state as AssetVersion["state"],
    base_version: row.base_version,
    title: row.title,
    summary: row.summary,
    content: row.content,
    content_hash: row.content_hash,
    author_user_id: row.author_user_id,
    change_note: row.change_note,
    created_at: row.created_at,
  };
}

export function findAssetRow(db: Db, id: string): AssetRow | null {
  const row = db.prepare("SELECT * FROM asset WHERE id = ?").get(id) as unknown as AssetRow | undefined;
  return row ?? null;
}

export function readVersionRow(db: Db, asset_id: string, version: number): VersionRow | null {
  const row = db
    .prepare("SELECT * FROM asset_version WHERE asset_id = ? AND version = ?")
    .get(asset_id, version) as unknown as VersionRow | undefined;
  return row ?? null;
}

export function readFile(
  db: Db,
  asset_id: string,
  version: number,
  path: string,
): { path: string; encoding: string; content: string } | null {
  const row = db
    .prepare("SELECT path, data FROM asset_file WHERE asset_id = ? AND version = ? AND path = ?")
    .get(asset_id, version, path) as { path: string; data: Uint8Array } | undefined;
  return row ? { path: row.path, encoding: "base64", content: Buffer.from(row.data).toString("base64") } : null;
}

/** skill 附属文件清单（只给路径与字节数，不读内容）。 */
export function listFiles(db: Db, asset_id: string, version: number): { path: string; bytes: number }[] {
  return db
    .prepare("SELECT path, bytes FROM asset_file WHERE asset_id = ? AND version = ? ORDER BY path")
    .all(asset_id, version) as unknown as { path: string; bytes: number }[];
}

// ---------------------------------------------------------------------------
// FTS（rowid = asset.seq；只索引 committed 的 current 版本，与写入同事务）
// ---------------------------------------------------------------------------

export function reindexFts(db: Db, seq: number, asset: Asset, version: AssetVersion): void {
  db.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(seq);
  db.prepare("INSERT INTO asset_fts (rowid, title, tags, summary, body) VALUES (?, ?, ?, ?, ?)").run(
    seq,
    asset.title,
    asset.tags.join(" "),
    asset.summary,
    version.content,
  );
}

function unindexFts(db: Db, seq: number): void {
  db.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(seq);
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

export interface CreateAssetInput {
  type: AssetType;
  name?: string;
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  layer?: MemoryLayer;
  files?: SkillFile[];
  /** O-7 自动沉淀：落私有草稿。默认 active（历史行为不变）。draft 语义见 access.ts——
   *  他人不可见、不进检索与配装；采纳 = inbox/adopt（activate，可同时申请共享）。 */
  status?: AssetStatus;
}

/** `source` 不是用户入参：由调用方按入口定（默认 tool；导入走 import.ts）。 */
export function createAsset(
  db: Db,
  principal: Principal,
  team_id: string,
  input: CreateAssetInput,
  source?: AssetSource,
): { asset: Asset; version: AssetVersion; files: NormalizedFiles[] } {
  requireTeamRole(db, team_id, principal.user.id, "member");
  const v = new Validator();
  const type = optOneOf(v, input, "type", ASSET_TYPES);
  if (type === undefined) v.issue("type is required");
  const title = reqString(v, input, "title", LIMITS.title);
  const content = reqString(v, input, "content");
  const summary = optString(v, input, "summary", LIMITS.summary) ?? "";
  const tags = optTags(v, input, "tags") ?? [];
  const layer = optOneOf(v, input, "layer", LAYERS);
  const status = optOneOf(v, input, "status", STATUSES);
  if (status !== undefined && status !== "active" && status !== "draft") {
    v.issue("status on create must be active | draft");
  }
  const name = optString(v, input, "name");
  if (Buffer.byteLength(content, "utf8") > LIMITS.content) v.issue(`content exceeds ${LIMITS.content} bytes`);
  if (layer !== undefined && type !== "memory") v.issue("layer only applies to memory");
  if (type === "skill") {
    if (name === undefined) {
      v.issue("skill requires name");
    } else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      v.issue("name must be a slug");
    } else {
      const fm = parseSkillFrontmatter(content);
      if (!fm) v.issue("SKILL.md must start with YAML frontmatter containing name and description");
      else if (fm.name !== name) v.issue(`SKILL.md frontmatter name "${fm.name}" must equal asset name "${name}"`);
    }
  }
  const files = normalizeFiles(v, input.files);
  if (type !== "skill" && files.length > 0) v.issue("files only apply to skill");
  v.done();

  return withTx(db, () => {
    const now = nowIso();
    const asset: Asset = {
      id: newId("ast"),
      team_id,
      type: type!,
      name: name ?? null,
      title,
      summary,
      layer: layer ?? null,
      tags,
      owner_user_id: principal.user.id,
      visibility: "private",
      status: status ?? "active",
      current_version: 1,
      expires_at: null,
      usage_count: 0,
      last_used_at: null,
      source: source ?? { origin: "tool", ...(principal.agent ? { agent_id: principal.agent.id } : {}) },
      created_at: now,
      updated_at: now,
    };
    const hash = contentHash({
      type: asset.type,
      title,
      summary,
      content,
      tags,
      layer: asset.layer,
      expires_at: asset.expires_at,
      files,
    });
    const version: AssetVersion = {
      asset_id: asset.id,
      version: 1,
      state: "committed",
      base_version: null,
      title,
      summary,
      content,
      content_hash: hash,
      author_user_id: principal.user.id,
      change_note: "",
      created_at: now,
    };
    try {
      db.prepare(
        `INSERT INTO asset (id, team_id, type, name, title, summary, layer, tags, owner_user_id, visibility, status,
                            current_version, expires_at, usage_count, last_used_at, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        asset.id,
        asset.team_id,
        asset.type,
        asset.name,
        asset.title,
        asset.summary,
        asset.layer,
        JSON.stringify(asset.tags),
        asset.owner_user_id,
        asset.visibility,
        asset.status,
        asset.current_version,
        asset.expires_at,
        asset.usage_count,
        asset.last_used_at,
        JSON.stringify(asset.source),
        asset.created_at,
        asset.updated_at,
      );
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) {
        throw alreadyExists(`asset name is taken: ${String(name)}`);
      }
      throw err;
    }
    db.prepare(
      `INSERT INTO asset_version (asset_id, version, state, base_version, title, summary, content, content_hash,
                                  author_user_id, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      version.asset_id,
      version.version,
      version.state,
      version.base_version,
      version.title,
      version.summary,
      version.content,
      version.content_hash,
      version.author_user_id,
      version.change_note,
      version.created_at,
    );
    for (const f of files) {
      db.prepare(
        "INSERT INTO asset_file (asset_id, version, path, bytes, sha256, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(asset.id, 1, f.path, f.bytes, f.sha256, f.data);
    }
    const seq = (db.prepare("SELECT seq FROM asset WHERE id = ?").get(asset.id) as { seq: number }).seq;
    reindexFts(db, seq, asset, version);
    return { asset, version, files };
  });
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export function getAsset(db: Db, principal: Principal, id: string): Asset {
  const row = findAssetRow(db, id);
  return requireRead(db, principal, row ? toAsset(row) : null);
}

export function getAssetDetail(
  db: Db,
  principal: Principal,
  id: string,
  version?: number,
  path?: string,
): { asset: Asset; version: AssetVersion; files?: { path: string; bytes: number }[]; file?: { path: string; encoding: string; content: string } } {
  const asset = getAsset(db, principal, id);
  const wanted = version ?? asset.current_version;
  const row = readVersionRow(db, asset.id, wanted);
  // 提议版本只对申请人与管理者可见
  if (!row) throw notFound("asset version not found");
  if (row.state === "proposed" && !canManage(db, principal, asset)) throw notFound("asset version not found");
  const out: { asset: Asset; version: AssetVersion; files?: { path: string; bytes: number }[]; file?: { path: string; encoding: string; content: string } } = {
    asset,
    version: toVersion(row),
  };
  if (asset.type === "skill") {
    const files = listFiles(db, asset.id, wanted);
    if (files.length > 0) out.files = files;
  }
  if (path !== undefined) {
    const file = readFile(db, asset.id, wanted, path);
    if (!file) throw notFound("file not found");
    out.file = file;
  }
  return out;
}

export function listAssets(db: Db, principal: Principal, body: Record<string, unknown>): {
  items: Asset[];
  next_cursor: string;
} {
  const v = new Validator();
  const page = readPage(v, body);
  const type = optOneOf(v, body, "type", ASSET_TYPES);
  const visibility = optOneOf(v, body, "visibility", VISIBILITIES);
  const status = optOneOf(v, body, "status", STATUSES);
  const tags = optTags(v, body);
  const hasOwnerRef = body["owner_user_id"] !== undefined || body["owner"] !== undefined;
  const hasTeamRef = body["team_id"] !== undefined || body["team"] !== undefined;
  v.done();
  // 过滤条件用 id；slug 与 id 同时给时必须指向同一个对象
  const teamFilter = hasTeamRef ? resolveTeam(db, body).id : undefined;
  const owner = hasOwnerRef ? resolveUserRef(db, body).id : undefined;

  const where = [ACCESSIBLE_SQL];
  if (teamFilter !== undefined) {
    where.push("a.team_id = :team");
  }
  if (type !== undefined) where.push("a.type = :type");
  if (visibility !== undefined) where.push("a.visibility = :vis");
  if (status !== undefined) where.push("a.status = :status");
  if (owner !== undefined) where.push("a.owner_user_id = :owner");
  const params: Record<string, string | number | null> = { ...accessibleParams(principal) };
  if (teamFilter !== undefined) params["team"] = teamFilter;
  if (type !== undefined) params["type"] = type;
  if (visibility !== undefined) params["vis"] = visibility;
  if (status !== undefined) params["status"] = status;
  if (owner !== undefined) params["owner"] = owner;
  // tags 用 JSON 子串过滤：标签已排序且去重，作为列表过滤器足够（检索走 FTS）
  for (let i = 0; i < (tags?.length ?? 0); i++) {
    where.push(`a.tags LIKE :tag${i}`);
    params[`tag${i}`] = `%${JSON.stringify(tags![i]).slice(1, -1)}%`;
  }
  params["limit"] = page.limit + 1;
  params["offset"] = page.offset;

  const rows = db
    .prepare(
      `SELECT a.* FROM asset a WHERE ${where.join(" AND ")}
       ORDER BY a.updated_at DESC, a.id LIMIT :limit OFFSET :offset`,
    )
    .all(params) as unknown as AssetRow[];
  return makePage(rows.map(toAsset), page);
}

export function getHistory(db: Db, principal: Principal, id: string): AssetVersion[] {
  const asset = getAsset(db, principal, id);
  const rows = db
    .prepare("SELECT * FROM asset_version WHERE asset_id = ? ORDER BY version")
    .all(asset.id) as unknown as VersionRow[];
  return rows
    .filter((r) => r.state !== "proposed" || canManage(db, principal, asset))
    .map(toVersion);
}

// ---------------------------------------------------------------------------
// 版本写入（内部工具，review 批准时复用）
// ---------------------------------------------------------------------------

export interface WriteVersionInput {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  layer: MemoryLayer | null;
  expires_at: string | null;
  files: NormalizedFiles[];
}

/** 以版本号 = max(version)+1 追加一行（可能有空洞），state 由调用方给。 */
export function appendVersion(
  db: Db,
  asset: Asset,
  state: "committed" | "proposed",
  base_version: number | null,
  author_user_id: string,
  input: WriteVersionInput,
  change_note: string,
): { version: AssetVersion; hash: string } {
  // 读当前最大版本号，含 proposed / rejected
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS n FROM asset_version WHERE asset_id = ?")
    .get(asset.id) as { n: number };
  const versionNo = maxRow.n + 1;
  const hash = contentHash({ type: asset.type, ...input, files: input.files });
  const now = nowIso();
  db.prepare(
    `INSERT INTO asset_version (asset_id, version, state, base_version, title, summary, content, content_hash,
                                author_user_id, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.id,
    versionNo,
    state,
    base_version,
    input.title,
    input.summary,
    input.content,
    hash,
    author_user_id,
    change_note,
    now,
  );
  db.prepare("DELETE FROM asset_file WHERE asset_id = ? AND version = ?").run(asset.id, versionNo);
  for (const f of input.files) {
    db.prepare(
      "INSERT INTO asset_file (asset_id, version, path, bytes, sha256, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(asset.id, versionNo, f.path, f.bytes, f.sha256, f.data);
  }
  return {
    version: {
      asset_id: asset.id,
      version: versionNo,
      state,
      base_version,
      title: input.title,
      summary: input.summary,
      content: input.content,
      content_hash: hash,
      author_user_id,
      change_note,
      created_at: now,
    },
    hash,
  };
}

/** 把指定版本置 committed 并推进指针，同时刷新 FTS。调用方负责事务与权限。
 *  meta 一并写回 asset 行，避免"先提交再改元数据"造成两次索引与两个 updated_at。 */
export function commitVersion(
  db: Db,
  asset: Asset,
  version: number,
  meta?: { title: string; summary: string; tags: string[]; layer: MemoryLayer | null; expires_at: string | null },
): Asset {
  const row = readVersionRow(db, asset.id, version);
  if (!row) throw notFound("asset version not found");
  if (row.state !== "committed" && row.state !== "proposed") throw notFound("asset version not found");
  const now = nowIso();
  db.prepare("UPDATE asset_version SET state = 'committed' WHERE asset_id = ? AND version = ?").run(asset.id, version);
  if (meta) {
    db.prepare(
      "UPDATE asset SET current_version = ?, title = ?, summary = ?, tags = ?, layer = ?, expires_at = ?, updated_at = ? WHERE id = ?",
    ).run(
      version,
      meta.title,
      meta.summary,
      JSON.stringify(meta.tags),
      meta.layer,
      meta.expires_at,
      now,
      asset.id,
    );
  } else {
    db.prepare("UPDATE asset SET current_version = ?, updated_at = ? WHERE id = ?").run(version, now, asset.id);
  }
  const next = toAsset(findAssetRow(db, asset.id)!);
  // archived 不进检索（data-model §4）；恢复时 applyStatus 会按现行版本重建
  if (next.status !== "archived") {
    const committed = readVersionRow(db, asset.id, version)!;
    const seq = (db.prepare("SELECT seq FROM asset WHERE id = ?").get(asset.id) as { seq: number }).seq;
    reindexFts(db, seq, next, toVersion(committed));
  }
  return next;
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

export interface UpdateAssetInput {
  base_version: number;
  content?: string;
  title?: string;
  summary?: string;
  tags?: string[];
  files?: SkillFile[];
  change_note?: string;
}

export interface UpdateResult {
  changed: boolean;
  version: number;
}

/** 合并补丁 → 新版本输入。版本只由 content_hash 决定是否产生（data-model §5）。 */
export function prepareUpdate(
  db: Db,
  asset: Asset,
  input: UpdateAssetInput,
): { next: WriteVersionInput; changed: boolean } {
  const v = new Validator();
  const title = optString(v, input, "title", LIMITS.title) ?? asset.title;
  const summary = optString(v, input, "summary", LIMITS.summary) ?? asset.summary;
  const tags = optTags(v, input, "tags") ?? asset.tags;
  const current = readVersionRow(db, asset.id, asset.current_version);
  if (!current) throw notFound("asset version not found");
  const content = optString(v, input, "content") ?? current.content;
  if (Buffer.byteLength(content, "utf8") > LIMITS.content) v.issue(`content exceeds ${LIMITS.content} bytes`);
  const files = normalizeFiles(v, input.files as SkillFile[] | undefined);
  if (asset.type !== "skill" && files.length > 0) v.issue("files only apply to skill");
  if (asset.type === "skill") {
    const fm = parseSkillFrontmatter(content);
    if (!fm) v.issue("SKILL.md must start with YAML frontmatter containing name and description");
    else if (fm.name !== asset.name) v.issue(`SKILL.md frontmatter name must equal asset name "${String(asset.name)}"`);
  }
  v.done();

  // 未给 files 时沿用现行版本的文件；必须连 data 一起带过来，否则新版本行会丢文件
  const carried: NormalizedFiles[] =
    input.files === undefined
      ? (
          db
            .prepare(
              "SELECT path, bytes, sha256, data FROM asset_file WHERE asset_id = ? AND version = ? ORDER BY path",
            )
            .all(asset.id, asset.current_version) as unknown as {
            path: string;
            bytes: number;
            sha256: string;
            data: Uint8Array;
          }[]
        ).map((r) => ({ path: r.path, bytes: r.bytes, sha256: r.sha256, data: Buffer.from(r.data) }))
      : files;

  const hash = contentHash({
    type: asset.type,
    title,
    summary,
    content,
    tags,
    layer: asset.layer,
    expires_at: asset.expires_at,
    files: carried.map((f) => ({ path: f.path, sha256: f.sha256 })),
  });
  return {
    next: {
      title,
      summary,
      content,
      tags,
      layer: asset.layer,
      expires_at: asset.expires_at,
      files: carried,
    },
    changed: hash !== current.content_hash,
  };
}

/** 以库里当前行为准；调用方手里的 Asset 可能是旧快照。 */
export function reloadAsset(db: Db, id: string): Asset {
  const row = findAssetRow(db, id);
  if (!row) throw notFound("asset not found");
  return toAsset(row);
}

export function updateAsset(db: Db, principal: Principal, asset: Asset, input: UpdateAssetInput): UpdateResult {
  // 先重读再判权限：可见性可能在本进程内刚刚变过，入参快照不可信
  const current = reloadAsset(db, asset.id);
  requireRead(db, principal, current);
  // 版本冲突以库为准：内存快照可能落后于同进程的其他写入
  if (input.base_version !== current.current_version) throw versionConflict(current.current_version);
  const { next, changed } = prepareUpdate(db, current, input);
  if (!changed) return { changed: false, version: current.current_version };
  return withTx(db, () => {
    const { version } = appendVersion(db, current, "committed", input.base_version, principal.user.id, next, input.change_note ?? "");
    commitVersion(db, current, version.version, next);
    return { changed: true, version: version.version };
  });
}

/** 仅可读者：写 proposed 版本行，返回版本号，由调用方建 review(update)。 */
export function proposeUpdate(
  db: Db,
  principal: Principal,
  asset: Asset,
  input: UpdateAssetInput,
): { version: number; next: WriteVersionInput } {
  // 先重读再判权限：可见性可能在本进程内刚刚变过，入参快照不可信
  const current = reloadAsset(db, asset.id);
  requireRead(db, principal, current);
  if (input.base_version !== current.current_version) throw versionConflict(current.current_version);
  const { next, changed } = prepareUpdate(db, current, input);
  if (!changed) throw invalid("invalid argument", ["proposal carries no change"]);
  return withTx(db, () => {
    const { version } = appendVersion(db, current, "proposed", input.base_version, principal.user.id, next, input.change_note ?? "");
    return { version: version.version, next };
  });
}

// ---------------------------------------------------------------------------
// 可见性
// ---------------------------------------------------------------------------

export interface VisibilityPlan {
  visibility: Visibility;
  acl: { subject_type: AclSubjectType; subject_id: string; permission: AclPermission }[];
}

/** 校验目标可见性与 ACL 形状；提升是否过审由 review 层决定。 */
export function planVisibility(db: Db, principal: Principal, asset: Asset, body: Record<string, unknown>): {
  plan: VisibilityPlan;
  elevates: boolean;
} {
  const current = reloadAsset(db, asset.id);
  requireManage(db, principal, current);
  const v = new Validator();
  const visibility = optOneOf(v, body, "visibility", VISIBILITIES);
  if (visibility === undefined) v.issue("visibility is required");
  const rawAcl = body["acl"];
  const acl: VisibilityPlan["acl"] = [];
  if (rawAcl !== undefined) {
    if (!Array.isArray(rawAcl)) v.issue("acl must be an array");
    else
      for (const entry of rawAcl as Record<string, unknown>[]) {
        const subject_type = optOneOf(v, entry ?? {}, "subject_type", ACL_SUBJECTS);
        const subject_id = optString(v, entry ?? {}, "subject_id");
        const permission = optOneOf(v, entry ?? {}, "permission", ACL_PERMISSIONS);
        if (subject_type === undefined) v.issue("acl.subject_type is required");
        if (subject_id === undefined) v.issue("acl.subject_id is required");
        if (permission === undefined) v.issue("acl.permission is required");
        if (subject_type === "role" && subject_id !== undefined && subject_id !== "admin" && subject_id !== "member") {
          v.issue("acl role subject must be admin | member");
        }
        if (subject_type !== undefined && subject_id !== undefined && permission !== undefined) {
          acl.push({ subject_type, subject_id, permission });
        }
      }
  }
  v.done();

  // 进入 restricted 必须带 ACL；已在 restricted 上的重复提交允许省略（沿用现有 ACL）
  if (visibility === "restricted" && acl.length === 0 && current.visibility !== "restricted") {
    v.issue("restricted visibility requires acl entries");
  }
  if (visibility !== "restricted" && acl.length > 0) v.issue("acl only applies to restricted visibility");
  v.done();
  const elevates = current.visibility === "private" && visibility !== "private";
  return { plan: { visibility: visibility!, acl }, elevates };
}

/** 应用可见性与 ACL（审批直通或批准后调用）。同名 skill 的团队内重名在同一事务里检查。
 *  granted_by 是实际做出这个决定的用户——审批通过时是审批人，不是 owner。 */
export function applyVisibility(db: Db, asset: Asset, plan: VisibilityPlan, granted_by: string): Asset {
  const current = reloadAsset(db, asset.id);
  return withTx(db, () => {
    if (current.type === "skill" && current.name !== null && plan.visibility !== "private") {
      const clash = db
        .prepare(
          `SELECT id FROM asset WHERE team_id = ? AND type = 'skill' AND name = ? AND id != ? AND visibility != 'private'`,
        )
        .get(current.team_id, current.name, current.id);
      if (clash) throw alreadyExists(`skill name is already shared in this team: ${current.name}`);
    }
    db.prepare("UPDATE asset SET visibility = ?, updated_at = ? WHERE id = ?").run(
      plan.visibility,
      nowIso(),
      current.id,
    );
    if (plan.visibility !== "restricted") {
      // 离开 restricted：旧 ACL 不能留，否则再次进入时会继承不该有的授权
      db.prepare("DELETE FROM acl WHERE asset_id = ?").run(current.id);
    } else if (plan.acl.length > 0) {
      // 只在显式给了 ACL 时整表替换；省略表示沿用现有授权
      db.prepare("DELETE FROM acl WHERE asset_id = ?").run(current.id);
      for (const entry of plan.acl) {
        db.prepare(
          "INSERT OR REPLACE INTO acl (asset_id, subject_type, subject_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(current.id, entry.subject_type, entry.subject_id, entry.permission, granted_by, nowIso());
      }
    }
    return toAsset(findAssetRow(db, current.id)!);
  });
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export type StatusAction = "activate" | "deprecate" | "archive" | "restore";

const TRANSITIONS: Record<StatusAction, { from: AssetStatus[]; to: AssetStatus }> = {
  activate: { from: ["draft", "deprecated"], to: "active" },
  deprecate: { from: ["active"], to: "deprecated" },
  archive: { from: ["draft", "active", "deprecated"], to: "archived" },
  restore: { from: ["archived"], to: "active" },
};

export function checkTransition(asset: Asset, action: StatusAction): AssetStatus {
  const t = TRANSITIONS[action];
  if (!t) throw invalid("invalid argument", [`unknown action ${String(action)}`]);
  if (!t.from.includes(asset.status)) {
    throw invalid("invalid argument", [`cannot ${action} an asset in status ${asset.status}`]);
  }
  return t.to;
}

/** 目标状态 → 允许的来源状态（applyStatus 用；动作视角由 checkTransition 提供）。 */
const REACHABLE: Record<AssetStatus, AssetStatus[]> = {
  draft: [],
  active: ["draft", "deprecated", "archived"],
  deprecated: ["active"],
  archived: ["draft", "active", "deprecated"],
};

export function applyStatus(db: Db, asset: Asset, to: AssetStatus): Asset {
  const current = reloadAsset(db, asset.id);
  if (!REACHABLE[to].includes(current.status)) {
    throw invalid("invalid argument", [`cannot move an asset in status ${current.status} to ${to}`]);
  }
  return withTx(db, () => {
    db.prepare("UPDATE asset SET status = ?, updated_at = ? WHERE id = ?").run(to, nowIso(), current.id);
    const next = toAsset(findAssetRow(db, current.id)!);
    const seq = (db.prepare("SELECT seq FROM asset WHERE id = ?").get(current.id) as { seq: number }).seq;
    if (to === "archived") {
      unindexFts(db, seq);
    } else {
      const version = readVersionRow(db, current.id, next.current_version);
      if (version) reindexFts(db, seq, next, toVersion(version));
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/** 仅 archived；Owner 或 SA。物理删除全部版本、文件、ACL、绑定、审批、用量与检索行。 */
export function purgeAsset(db: Db, principal: Principal, asset: Asset): void {
  const current = reloadAsset(db, asset.id);
  const actor = getUserById(db, principal.user.id);
  if (current.owner_user_id !== principal.user.id && !(actor?.is_system_admin ?? false)) {
    throw forbidden("owner or system admin required");
  }
  if (current.status !== "archived") throw invalid("invalid argument", ["only archived assets can be purged"]);
  withTx(db, () => {
    const seq = (db.prepare("SELECT seq FROM asset WHERE id = ?").get(current.id) as { seq: number }).seq;
    unindexFts(db, seq);
    db.prepare("DELETE FROM asset_file WHERE asset_id = ?").run(current.id);
    db.prepare("DELETE FROM asset_version WHERE asset_id = ?").run(current.id);
    db.prepare("DELETE FROM acl WHERE asset_id = ?").run(current.id);
    db.prepare("DELETE FROM agent_asset WHERE asset_id = ?").run(current.id);
    db.prepare("DELETE FROM review WHERE asset_id = ?").run(current.id);
    db.prepare("DELETE FROM usage_daily WHERE asset_id = ?").run(current.id);
    db.prepare("DELETE FROM asset WHERE id = ?").run(current.id);
  });
}

// ---------------------------------------------------------------------------
// ACL
// ---------------------------------------------------------------------------

export interface AclEntry {
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: AclPermission;
  granted_by: string;
  created_at: string;
}

export function grantAcl(db: Db, principal: Principal, asset: Asset, entry: {
  subject_type: AclSubjectType;
  subject_id: string;
  permission: AclPermission;
}): AclEntry {
  const current = reloadAsset(db, asset.id);
  requireManage(db, principal, current);
  if (current.visibility !== "restricted") {
    throw invalid("invalid argument", ["acl only applies to restricted visibility"]);
  }
  if (entry.subject_type === "role" && entry.subject_id !== "admin" && entry.subject_id !== "member") {
    throw invalid("invalid argument", ["acl role subject must be admin | member"]);
  }
  // 幂等：重复授权覆盖权限，不新增行，created_at 保持首次授权时间
  const existing = db
    .prepare("SELECT created_at FROM acl WHERE asset_id = ? AND subject_type = ? AND subject_id = ?")
    .get(current.id, entry.subject_type, entry.subject_id) as { created_at: string } | undefined;
  const created_at = existing?.created_at ?? nowIso();
  db.prepare(
    "INSERT OR REPLACE INTO acl (asset_id, subject_type, subject_id, permission, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(current.id, entry.subject_type, entry.subject_id, entry.permission, principal.user.id, created_at);
  return { asset_id: current.id, ...entry, granted_by: principal.user.id, created_at };
}

export function revokeAcl(db: Db, principal: Principal, asset: Asset, entry: {
  subject_type: AclSubjectType;
  subject_id: string;
}): void {
  const current = reloadAsset(db, asset.id);
  requireManage(db, principal, current);
  const row = db
    .prepare("SELECT 1 AS x FROM acl WHERE asset_id = ? AND subject_type = ? AND subject_id = ?")
    .get(current.id, entry.subject_type, entry.subject_id);
  if (!row) throw notFound("acl entry not found");
  db.prepare("DELETE FROM acl WHERE asset_id = ? AND subject_type = ? AND subject_id = ?").run(
    current.id,
    entry.subject_type,
    entry.subject_id,
  );
}

export function listAcl(db: Db, principal: Principal, asset: Asset): AclEntry[] {
  const current = reloadAsset(db, asset.id);
  requireRead(db, principal, current);
  return db
    .prepare("SELECT * FROM acl WHERE asset_id = ? ORDER BY subject_type, subject_id")
    .all(current.id) as unknown as AclEntry[];
}

/**
 * acl/check：本人（或本人某个 Agent）对该资产的权限自查。
 * 看不见即 NOT_FOUND（不泄露存在性）；agent_id 必须是本人的 Agent。
 * via 说明权限来自哪条规则：owner / acl / role / admin，null 表示无此权限。
 */
export function checkAcl(db: Db, principal: Principal, asset_id: string, agent_id?: string): {
  read: boolean;
  manage: boolean;
  via: "owner" | "acl" | "role" | "admin" | null;
} {
  const current = reloadAsset(db, asset_id);
  if (agent_id !== undefined) {
    const agent = db.prepare("SELECT owner_user_id FROM agent WHERE id = ?").get(agent_id) as
      | { owner_user_id: string }
      | undefined;
    if (!agent || agent.owner_user_id !== principal.user.id) throw forbidden("agent is not owned by the caller");
  }
  const subject: Principal = agent_id === undefined
    ? principal
    : { user: principal.user, agent: { id: agent_id, owner_user_id: principal.user.id } };
  requireRead(db, subject, current);
  return {
    read: readVia(db, subject, current) !== null,
    manage: manageVia(db, subject, current) !== null,
    via: readVia(db, subject, current),
  };
}

/** 过期即不可注入：运行期把过期资产按 deprecated 处理（data-model §4）。 */
export function isExpired(asset: Asset, now = nowIso()): boolean {
  return asset.expires_at !== null && asset.expires_at <= now;
}
