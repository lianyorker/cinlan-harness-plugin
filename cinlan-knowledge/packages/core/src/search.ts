import type { AssetHit, AssetType, Visibility } from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import { vecAvailable } from "./db.js";
import { vecTableExists } from "./embedding.js";
import { accessibleParams, ACCESSIBLE_SQL, NOT_EXPIRED_SQL } from "./access.js";
import type { Principal } from "./access.js";
import { invalid } from "./errors.js";
import { nowIso } from "./ids.js";
import { resolveTeam } from "./meta.js";
import { optInt, optTags, Validator } from "./validate.js";

/**
 * 运行视角检索（api.md §3 `asset/search`）。
 * 范围先收窄再排序：可读集合（ACCESSIBLE_SQL）+ 非过期（NOT_EXPIRED_SQL），
 * 与配装共用同一份 SQL 条件（data-model §4）。`deprecated` 可见但降权。
 */

const TYPES: readonly AssetType[] = ["memory", "skill", "wiki", "codegraph"];
const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 20;
/** 候选上限：排序在 JS 里做，先按更新时间取一批，避免全表扫描。 */
const CANDIDATE_CAP = 200;
/** 查询词上限，防止构造超长 MATCH。 */
const MAX_TERMS = 8;
const QUERY_MAX_CHARS = 200;

/** trigram 至少要 3 个字符才能命中；按码点计，2 字中文走 LIKE。 */
const TRIGRAM_MIN = 3;

interface HitRow {
  seq: number;
  id: string;
  team_id: string;
  type: string;
  title: string;
  summary: string;
  tags: string;
  visibility: string;
  status: string;
  current_version: number;
  updated_at: string;
  owner_user_id: string;
  owner_name: string;
  body: string | null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** FTS5 短语：整体加引号，内部双引号成对转义，避免把用户输入当语法。 */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function splitTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of query.trim().split(/\s+/)) {
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

function hitsIn(text: string, term: string): boolean {
  return text.toLowerCase().includes(term.toLowerCase());
}

/** 单项得分：同一词取命中的最高权列（标题 > 标签/摘要 > 正文），各词累加。 */
function scoreRow(row: HitRow, terms: string[]): number {
  let score = 0;
  const tags = row.tags;
  const body = row.body ?? "";
  for (const term of terms) {
    if (hitsIn(row.title, term)) score += 3;
    else if (hitsIn(tags, term) || hitsIn(row.summary, term)) score += 2;
    else if (hitsIn(body, term)) score += 1;
  }
  if (row.status === "deprecated") score *= 0.5;
  return Math.round(score * 100) / 100;
}

/** 片段：正文里第一个命中词前后各取一段；没有命中正文时退回首段正文。 */
function snippetOf(row: HitRow, terms: string[]): string {
  const body = (row.body ?? "").replace(/\s+/g, " ").trim();
  if (body === "") return row.summary.slice(0, 80);
  let at = -1;
  for (const term of terms) {
    const i = body.toLowerCase().indexOf(term.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const from = at === -1 ? 0 : Math.max(0, at - 30);
  const window = body.slice(from, from + 80);
  return `${from > 0 ? "…" : ""}${window}${from + 80 < body.length ? "…" : ""}`;
}

export function searchAssets(
  db: Db,
  principal: Principal,
  body: Record<string, unknown>,
): { hits: AssetHit[] } {
  const v = new Validator();
  const rawQuery = typeof body["query"] === "string" ? body["query"] : undefined;
  if (rawQuery === undefined || rawQuery.trim() === "") v.issue("query is required");
  if (rawQuery !== undefined && rawQuery.length > QUERY_MAX_CHARS) v.issue(`query exceeds ${QUERY_MAX_CHARS} chars`);

  const rawTypes = body["types"];
  let types: AssetType[] | undefined;
  if (rawTypes !== undefined && rawTypes !== null) {
    if (!Array.isArray(rawTypes)) {
      v.issue("types must be an array");
    } else {
      const picked = rawTypes.filter((t): t is AssetType => TYPES.includes(t as AssetType));
      if (picked.length !== rawTypes.length) v.issue(`types must be one of ${TYPES.join(" | ")}`);
      types = picked;
    }
  }
  const tags = optTags(v, body);
  const limit = optInt(v, body, "limit", 1, LIMIT_MAX) ?? LIMIT_DEFAULT;
  // O-9 向量路（可选）：传 query_embedding 才启用。调用方（ck / worker）先用同一模型
  // 把查询文本转向量再送来——hub 自身零 LLM。没传时行为与历史完全一致（纯 FTS）。
  const rawVec = body["query_embedding"];
  let queryVector: number[] | undefined;
  if (rawVec !== undefined && rawVec !== null) {
    if (
      !Array.isArray(rawVec) ||
      rawVec.length < 1 ||
      rawVec.length > 4096 ||
      !rawVec.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      v.issue("query_embedding must be an array of 1..4096 finite numbers");
    } else {
      queryVector = rawVec as number[];
    }
  }
  // 团队过滤是收窄而不是授权：越权团队只会在可读集合上再取交集，结果为空，不泄露
  const teamRef = { team_id: body["team_id"], team: body["team"] };
  const hasTeam = teamRef.team_id !== undefined || teamRef.team !== undefined;
  v.done();

  const team_id = hasTeam ? resolveTeam(db, teamRef).id : undefined;

  const terms = splitTerms(rawQuery!);
  if (terms.length === 0) return { hits: [] };

  // 基础过滤（FTS 路与向量路共用）：可读集合 + 状态 + 非过期 + 团队 / 类型 / 标签
  const baseWhere: string[] = [ACCESSIBLE_SQL, "a.status IN ('active', 'deprecated')", NOT_EXPIRED_SQL];
  const baseParams: Record<string, string | number | null> = { ...accessibleParams(principal), now: nowIso() };

  if (team_id !== undefined) {
    baseWhere.push("a.team_id = :team_id");
    baseParams["team_id"] = team_id;
  }

  if (types !== undefined && types.length > 0) {
    baseWhere.push(`a.type IN (${types.map((t, i) => `:type${i}`).join(", ")})`);
    types.forEach((t, i) => (baseParams[`type${i}`] = t));
  }
  // 标签过滤：与 asset/list 同一口径（标签已排序去重，JSON 子串足够）
  for (let i = 0; i < (tags?.length ?? 0); i++) {
    baseWhere.push(`a.tags LIKE :tag${i} ESCAPE '\\'`);
    baseParams[`tag${i}`] = `%${escapeLike(JSON.stringify(tags![i]!).slice(1, -1))}%`;
  }
  // 词条件只属于 FTS 路（语义路不能被词法命中卡死）
  const where = [...baseWhere];
  const params: Record<string, string | number | null> = { ...baseParams };
  // 每个词一个条件，词之间是 AND；≥3 字符走 FTS，短词走 LIKE 兜底
  terms.forEach((term, i) => {
    if ([...term].length >= TRIGRAM_MIN) {
      where.push(`a.seq IN (SELECT rowid FROM asset_fts WHERE asset_fts MATCH :match${i})`);
      params[`match${i}`] = ftsPhrase(term);
    } else {
      const p = `%${escapeLike(term)}%`;
      where.push(
        `EXISTS (SELECT 1 FROM asset_fts f WHERE f.rowid = a.seq AND
           (f.title LIKE :like${i} ESCAPE '\\' OR f.summary LIKE :like${i} ESCAPE '\\'
            OR f.tags LIKE :like${i} ESCAPE '\\' OR f.body LIKE :like${i} ESCAPE '\\'))`,
      );
      params[`like${i}`] = p;
    }
  });
  params["cap"] = CANDIDATE_CAP;

  const rows = db
    .prepare(
      `SELECT a.seq, a.id, a.team_id, a.type, a.title, a.summary, a.tags, a.visibility, a.status,
              a.current_version, a.updated_at, a.owner_user_id, u.name AS owner_name,
              (SELECT f.body FROM asset_fts f WHERE f.rowid = a.seq) AS body
         FROM asset a JOIN user u ON u.id = a.owner_user_id
        WHERE ${where.join(" AND ")}
        ORDER BY (a.status = 'deprecated') ASC, a.updated_at DESC, a.id ASC
        LIMIT :cap`,
    )
    .all(params) as unknown as HitRow[];

  const ranked = rows
    .map((row) => ({ row, score: scoreRow(row, terms) }))
    .sort(
      (x, y) =>
        y.score - x.score ||
        Number(x.row.status === "deprecated") - Number(y.row.status === "deprecated") ||
        (x.row.updated_at < y.row.updated_at ? 1 : x.row.updated_at > y.row.updated_at ? -1 : 0) ||
        (x.row.id < y.row.id ? -1 : 1),
    );

  // ---- 向量路（O-9）：KNN overfetch 后在同一 SQL 里过权限/状态/过期/团队/类型/标签 ----
  if (queryVector !== undefined && (!vecAvailable(db) || !vecTableExists(db))) {
    // 调用方显式带了向量，说明它期望语义路存在；静默退化会掩盖「没装扩展 / 没建索引」的事实
    throw invalid("vector search is not enabled on this hub (sqlite-vec or embedding index unavailable)");
  }
  let vecRows: (HitRow & { distance: number })[] = [];
  if (queryVector !== undefined) {
    const knnK = Math.min(Math.max(limit * 4, 16), 256);
    vecRows = db
      .prepare(
        `SELECT a.seq, a.id, a.team_id, a.type, a.title, a.summary, a.tags, a.visibility, a.status,
                a.current_version, a.updated_at, a.owner_user_id, u.name AS owner_name,
                (SELECT f.body FROM asset_fts f WHERE f.rowid = a.seq) AS body,
                v.distance AS distance
           FROM (SELECT rowid, distance FROM embedding_vec WHERE embedding MATCH :qv AND k = CAST(:qk AS INTEGER)) v
           JOIN embedding_chunk ec ON ec.id = v.rowid
           JOIN asset a ON a.id = ec.asset_id
           JOIN user u ON u.id = a.owner_user_id
          WHERE ec.version = a.current_version AND ${baseWhere.join(" AND ")}
          ORDER BY v.distance
          LIMIT CAST(:vlimit AS INTEGER)`,
      )
      .all({ ...baseParams, qv: Buffer.from(new Float32Array(queryVector).buffer), qk: knnK, vlimit: limit }) as unknown as (HitRow & {
      distance: number;
    })[];
  }

  // ---- 融合：双路各取 top-limit，RRF（k=60）合并；单路为空时自然退化为另一路 ----
  const RRF_K = 60;
  let final: { row: HitRow; score: number }[];
  if (queryVector !== undefined && vecRows.length > 0) {
    const rrf = new Map<string, number>();
    const bump = (rs: HitRow[]): void => {
      rs.forEach((row, i) => rrf.set(row.id, (rrf.get(row.id) ?? 0) + 1 / (RRF_K + i + 1)));
    };
    const ftsScore = new Map(ranked.map(({ row, score }) => [row.id, score] as const));
    bump(ranked.slice(0, limit).map((r) => r.row));
    bump(vecRows);
    const all = new Map(ranked.map(({ row }) => [row.id, row] as const));
    for (const row of vecRows) all.set(row.id, row);
    final = [...all.values()]
      .map((row) => ({
        row,
        score: Math.round((rrf.get(row.id) ?? 0) * 1e4) / 1e4,
        tie: (ftsScore.get(row.id) ?? 0) - Number(row.status === "deprecated") * 1e-6,
      }))
      .sort(
        (x, y) =>
          (rrf.get(y.row.id) ?? 0) - (rrf.get(x.row.id) ?? 0) ||
          y.tie - x.tie ||
          (x.row.updated_at < y.row.updated_at ? 1 : x.row.updated_at > y.row.updated_at ? -1 : 0) ||
          (x.row.id < y.row.id ? -1 : 1),
      )
      .slice(0, limit);
  } else {
    final = ranked.slice(0, limit);
  }

  const hits: AssetHit[] = final.map(({ row, score }) => ({
    asset_id: row.id,
    type: row.type as AssetType,
    title: row.title,
    summary: row.summary,
    snippet: snippetOf(row, terms),
    score,
    version: row.current_version,
    visibility: row.visibility as Visibility,
    owner: { id: row.owner_user_id, name: row.owner_name },
    team_id: row.team_id,
    deprecated: row.status === "deprecated",
    updated_at: row.updated_at,
  }));
  return { hits };
}
