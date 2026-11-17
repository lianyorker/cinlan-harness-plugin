import type { Db } from "./db.js";
import { vecAvailable } from "./db.js";
import { withTx } from "./tx.js";
import { DomainError } from "./errors.js";
import { nowIso } from "./ids.js";
import { accessibleParams, ACCESSIBLE_SQL, NOT_EXPIRED_SQL } from "./access.js";
import type { Principal } from "./access.js";
import { resolveTeam } from "./meta.js";
import { optInt, Validator } from "./validate.js";

/**
 * 向量检索的存取层（O-9，vector-search.md §4.1）。
 * 阶段一分块策略：整条资产一个向量（调用方把 title+summary+content 拼成一段交给模型）。
 * 维度在 vec0 建表时定死——换模型若维度不同，需 drop 重建 + 全量重算（由回填命令负责）。
 */

/** vec0 虚表名。rowid 与 embedding_chunk.id 同值。 */
const VEC_TABLE = "embedding_vec";

export function ensureVec0(db: Db, dims: number): boolean {
  if (!Number.isInteger(dims) || dims < 1 || dims > 4096) {
    throw new DomainError("INVALID_ARGUMENT", `dims must be an integer in [1, 4096], got ${dims}`);
  }
  if (!vecAvailable(db)) return false;
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(embedding float[${dims}] distance_metric=cosine)`);
  return true;
}

/** vec0 虚表是否已建（检索路的「向量检索已启用」判定 = 扩展在 + 表在）。 */
export function vecTableExists(db: Db): boolean {
  try {
    const row = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = ?`).get(VEC_TABLE) as { ok: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

export interface PutEmbeddingInput {
  asset_id: string;
  version: number;
  model: string;
  vectors: number[][];
}

/** 覆盖式写入一个资产的全部向量（旧版本先删）。成功返回写入条数。 */
export function putEmbeddings(db: Db, input: PutEmbeddingInput): number {
  if (!vecAvailable(db)) {
    throw new DomainError("INVALID_ARGUMENT", "vector extension unavailable on this connection");
  }
  if (input.vectors.length === 0) throw new DomainError("INVALID_ARGUMENT", "vectors must not be empty");
  if (input.vectors.length > 64) throw new DomainError("INVALID_ARGUMENT", "at most 64 vectors per asset");
  if (!input.model.trim()) throw new DomainError("INVALID_ARGUMENT", "model is required");
  const dims = input.vectors[0]!.length;
  if (!Number.isInteger(dims) || dims < 1 || dims > 4096) {
    throw new DomainError("INVALID_ARGUMENT", "vector dimensions must be in [1, 4096]");
  }
  for (const vec of input.vectors) {
    if (vec.length !== dims) throw new DomainError("INVALID_ARGUMENT", "vectors must share the same dimensions");
    for (const x of vec) {
      if (!Number.isFinite(x)) throw new DomainError("INVALID_ARGUMENT", "vector components must be finite");
    }
  }
  return withTx(db, () => {
    deleteEmbeddings(db, input.asset_id);
    const now = nowIso();
    const insChunk = db.prepare(
      `INSERT INTO embedding_chunk (asset_id, version, seq_in_asset, model, dims, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // node:sqlite 把 JS number 绑成 DOUBLE，vec0 的整型主键只认整型：SQL 里 CAST。
    const insVec = db.prepare(
      `INSERT INTO ${VEC_TABLE} (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`,
    );
    input.vectors.forEach((vector, seq) => {
      const info = insChunk.run(input.asset_id, input.version, seq, input.model.trim(), dims, now) as unknown as {
        lastInsertRowid: number | bigint;
      };
      const id = Number(info.lastInsertRowid);
      insVec.run(id, Buffer.from(new Float32Array(vector).buffer));
    });
    return input.vectors.length;
  });
}

/** 删一个资产的全部向量（embedding_chunk + vec0 同步删）。 */
export function deleteEmbeddings(db: Db, asset_id: string): void {
  const rows = db
    .prepare(`SELECT id FROM embedding_chunk WHERE asset_id = ?`)
    .all(asset_id) as { id: number }[];
  if (rows.length === 0) return;
  const delVec = db.prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid = CAST(? AS INTEGER)`);
  const delChunk = db.prepare(`DELETE FROM embedding_chunk WHERE id = CAST(? AS INTEGER)`);
  withTx(db, () => {
    for (const row of rows) {
      delVec.run(row.id);
      delChunk.run(row.id);
    }
  });
}

export interface KnnHit {
  asset_id: string;
  distance: number;
}

export interface PendingItem {
  asset_id: string;
  version: number;
  title: string;
  type: string;
  visibility: string;
  updated_at: string;
}

/** 回填差集（O-9 通道 A）：调用者可读、active、现行版本没有向量的资产。 */
export function pendingEmbeddings(db: Db, principal: Principal, body: Record<string, unknown>): { items: PendingItem[] } {
  const v = new Validator();
  const limit = optInt(v, body, "limit", 1, 200) ?? 100;
  const hasTeam = body["team_id"] !== undefined || body["team"] !== undefined;
  v.done();
  const team_id = hasTeam ? resolveTeam(db, { team_id: body["team_id"], team: body["team"] }).id : undefined;
  const rows = db
    .prepare(
      `SELECT a.id AS asset_id, a.current_version AS version, a.title, a.type, a.visibility, a.updated_at
         FROM asset a
        WHERE ${ACCESSIBLE_SQL} AND a.status = 'active' AND ${NOT_EXPIRED_SQL}
          ${team_id !== undefined ? "AND a.team_id = :team_id" : ""}
          AND NOT EXISTS (
            SELECT 1 FROM embedding_chunk ec WHERE ec.asset_id = a.id AND ec.version = a.current_version
          )
        ORDER BY a.updated_at DESC, a.id ASC
        LIMIT CAST(:lim AS INTEGER)`,
    )
    .all({
      ...accessibleParams(principal),
      now: nowIso(),
      ...(team_id !== undefined ? { team_id } : {}),
      lim: limit,
    }) as unknown as PendingItem[];
  return { items: rows };
}

/**
 * KNN 原始查询（不带权限过滤——searchAssets 负责在 SQL 里 join 过滤）。
 * 返回 embedding_vec 里最近的 k 条，按 distance 升序。
 */
export function knnRaw(db: Db, queryVector: number[], k: number): KnnHit[] {
  if (!vecAvailable(db)) return [];
  const blob = Buffer.from(new Float32Array(queryVector).buffer);
  const rows = db
    .prepare(
      `SELECT ec.asset_id AS asset_id, v.distance AS distance
         FROM (SELECT rowid, distance FROM ${VEC_TABLE} WHERE embedding MATCH ? AND k = CAST(? AS INTEGER)) v
         JOIN embedding_chunk ec ON ec.id = v.rowid
        ORDER BY v.distance`,
    )
    .all(blob, k) as unknown as KnnHit[];
  return rows;
}
