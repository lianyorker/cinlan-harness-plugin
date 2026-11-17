import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AssetStatus,
  AssetType,
  BackupInfo,
  IntegrityIssue,
  IntegrityReport,
  MemoryLayer,
  SystemStats,
  User,
} from "@cinlan/knowledge-sdk";
import { contentHash } from "./asset.js";
import { backupTo, currentVersion, type Db } from "./db.js";
import { alreadyExists } from "./errors.js";
import { nowIso, sha256Hex } from "./ids.js";
import { requireSystemAdmin } from "./meta.js";

/**
 * `system/*`（api.md §3.5，P2）：全部仅 SA。
 * 统计与复算都是只读；备份只往调用方给的目录里添文件，从不覆盖。
 */

const ASSET_TYPES = ["memory", "skill", "wiki", "codegraph"] as const satisfies readonly AssetType[];
const ASSET_STATUSES = ["draft", "active", "deprecated", "archived"] as const satisfies readonly AssetStatus[];

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** GROUP BY 的结果摊到固定键上：没有行的键是 0，响应的字段集合因此恒定。 */
function tally<K extends string>(db: Db, sql: string, keys: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const row of db.prepare(sql).all() as unknown as { k: string; n: number }[]) {
    if (row.k in out) out[row.k as K] = row.n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 库存统计
// ---------------------------------------------------------------------------

export function systemStats(db: Db, actor: User): SystemStats {
  requireSystemAdmin(actor);
  const users = tally(db, "SELECT status AS k, COUNT(*) AS n FROM user GROUP BY status", ["active", "disabled"] as const);
  const agents = tally(db, "SELECT status AS k, COUNT(*) AS n FROM agent GROUP BY status", ["active", "archived"] as const);
  const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const files = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM asset_file").get() as {
    n: number;
    bytes: number;
  };
  return {
    generated_at: nowIso(),
    schema_version: currentVersion(db),
    db_bytes: pages * pageSize,
    users: { total: count(db, "SELECT COUNT(*) AS n FROM user"), active: users.active, disabled: users.disabled },
    teams: count(db, "SELECT COUNT(*) AS n FROM team"),
    agents: {
      total: count(db, "SELECT COUNT(*) AS n FROM agent"),
      active: agents.active,
      archived: agents.archived,
      templates: count(db, "SELECT COUNT(*) AS n FROM agent WHERE is_template = 1"),
    },
    assets: {
      total: count(db, "SELECT COUNT(*) AS n FROM asset"),
      by_type: tally(db, "SELECT type AS k, COUNT(*) AS n FROM asset GROUP BY type", ASSET_TYPES),
      by_status: tally(db, "SELECT status AS k, COUNT(*) AS n FROM asset GROUP BY status", ASSET_STATUSES),
      // 时效治理（deep-memory.md §5 #2）：已过期 vs 7 天内将过期
      expired: count(db, "SELECT COUNT(*) AS n FROM asset WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')"),
      expiring_7d: count(db, "SELECT COUNT(*) AS n FROM asset WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at >= datetime('now') AND expires_at <= datetime('now', '+7 days')"),
    },
    versions: count(db, "SELECT COUNT(*) AS n FROM asset_version"),
    files: { total: files.n, bytes: files.bytes },
    reviews: {
      total: count(db, "SELECT COUNT(*) AS n FROM review"),
      pending: count(db, "SELECT COUNT(*) AS n FROM review WHERE status = 'pending'"),
    },
    usage_rows: count(db, "SELECT COUNT(*) AS n FROM usage_daily"),
    audit_rows: count(db, "SELECT COUNT(*) AS n FROM audit"),
  };
}

// ---------------------------------------------------------------------------
// 完整性复算
// ---------------------------------------------------------------------------

/** 报告里最多带这么多条明细；计数始终是全量。 */
const ISSUE_LIMIT = 200;

interface AssetScan {
  seq: number;
  id: string;
  type: string;
  title: string;
  summary: string;
  layer: string | null;
  tags: string;
  status: string;
  current_version: number;
  expires_at: string | null;
}

interface VersionScan {
  version: number;
  state: string;
  title: string;
  summary: string;
  content: string;
  content_hash: string;
}

interface FileScan {
  path: string;
  bytes: number;
  sha256: string;
  data: Uint8Array;
}

interface FtsScan {
  title: string;
  tags: string;
  summary: string;
  body: string;
}

/**
 * 对全库复算（data-model §5、sop.md T7）。hash 只用写入时的那个 `contentHash`，
 * 输入也按写入时的口径取：title / summary / content 来自版本行，文件清单来自该版本的
 * asset_file，tags / layer / expires_at 来自资产行。
 *
 * 资产行上的 tags 只代表现行版本——改过标签之后，更早的版本（以及按旧标签提的 proposed /
 * rejected 行）就复算不出原 hash 了。这类行记为 `unverifiable`，不报不一致；
 * 现行版本则必须分毫不差，否则就是 `hash_mismatch`。
 */
export function checkIntegrity(db: Db, actor: User): IntegrityReport {
  requireSystemAdmin(actor);
  const issues: IntegrityIssue[] = [];
  let issue_count = 0;
  const report = (issue: IntegrityIssue): void => {
    issue_count++;
    if (issues.length < ISSUE_LIMIT) issues.push(issue);
  };
  const versions = { total: 0, verified: 0, unverifiable: 0, mismatched: 0 };
  const files = { total: 0, mismatched: 0 };
  const fts = { indexed: count(db, "SELECT COUNT(*) AS n FROM asset_fts"), missing: 0, stale: 0, orphaned: 0 };

  const versionStmt = db.prepare(
    "SELECT version, state, title, summary, content, content_hash FROM asset_version WHERE asset_id = ? ORDER BY version",
  );
  const fileStmt = db.prepare("SELECT path, bytes, sha256, data FROM asset_file WHERE asset_id = ? AND version = ?");
  const ftsStmt = db.prepare("SELECT title, tags, summary, body FROM asset_fts WHERE rowid = ?");

  const assets = db
    .prepare("SELECT seq, id, type, title, summary, layer, tags, status, current_version, expires_at FROM asset ORDER BY seq")
    .all() as unknown as AssetScan[];
  for (const asset of assets) {
    const tags = JSON.parse(asset.tags) as string[];
    let current: VersionScan | null = null;
    for (const v of versionStmt.all(asset.id) as unknown as VersionScan[]) {
      const isCurrent = v.version === asset.current_version && v.state === "committed";
      if (isCurrent) current = v;

      // 与 normalizeFiles 同一个排序，hash 的文件清单才对得上
      const rows = (fileStmt.all(asset.id, v.version) as unknown as FileScan[]).sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      for (const f of rows) {
        files.total++;
        if (f.data.length !== f.bytes || sha256Hex(f.data) !== f.sha256) {
          files.mismatched++;
          report({
            kind: "file_mismatch",
            asset_id: asset.id,
            version: v.version,
            path: f.path,
            detail: "stored sha256 / bytes differ from the file data",
          });
        }
      }

      versions.total++;
      const expected = contentHash({
        type: asset.type as AssetType,
        title: v.title,
        summary: v.summary,
        content: v.content,
        tags,
        layer: asset.layer as MemoryLayer | null,
        expires_at: asset.expires_at,
        files: rows,
      });
      if (expected === v.content_hash) {
        versions.verified++;
      } else if (isCurrent) {
        versions.mismatched++;
        report({
          kind: "hash_mismatch",
          asset_id: asset.id,
          version: v.version,
          path: null,
          detail: "content_hash differs from the recomputed value",
        });
      } else {
        versions.unverifiable++;
      }
    }

    if (current === null) {
      report({
        kind: "dangling_version",
        asset_id: asset.id,
        version: asset.current_version,
        path: null,
        detail: "current_version has no committed version row",
      });
    }

    // 检索：archived 不索引，其余状态必须有且等于现行版本（asset.ts 的 reindexFts）
    const indexed = ftsStmt.get(asset.seq) as unknown as FtsScan | undefined;
    if (asset.status === "archived") {
      if (indexed) {
        fts.orphaned++;
        report({ kind: "fts_orphan", asset_id: asset.id, version: null, path: null, detail: "archived asset is still indexed" });
      }
    } else if (current !== null) {
      if (!indexed) {
        fts.missing++;
        report({ kind: "fts_missing", asset_id: asset.id, version: current.version, path: null, detail: "asset has no search row" });
      } else if (
        indexed.title !== asset.title ||
        indexed.tags !== tags.join(" ") ||
        indexed.summary !== asset.summary ||
        indexed.body !== current.content
      ) {
        fts.stale++;
        report({
          kind: "fts_stale",
          asset_id: asset.id,
          version: current.version,
          path: null,
          detail: "search row differs from the current version",
        });
      }
    }
  }

  const strays = db
    .prepare("SELECT rowid AS seq FROM asset_fts WHERE rowid NOT IN (SELECT seq FROM asset) ORDER BY rowid")
    .all() as unknown as { seq: number }[];
  for (const row of strays) {
    fts.orphaned++;
    report({ kind: "fts_orphan", asset_id: null, version: null, path: null, detail: `search row ${row.seq} has no asset` });
  }

  for (const row of db.prepare("PRAGMA integrity_check").all() as unknown as { integrity_check: string }[]) {
    if (row.integrity_check !== "ok") {
      report({ kind: "sqlite", asset_id: null, version: null, path: null, detail: row.integrity_check });
    }
  }
  const broken = db.prepare("PRAGMA foreign_key_check").all() as unknown as {
    table: string;
    rowid: number | null;
    parent: string;
  }[];
  for (const row of broken) {
    report({
      kind: "sqlite",
      asset_id: null,
      version: null,
      path: null,
      detail: `foreign key violation: ${row.table} rowid ${String(row.rowid)} -> ${row.parent}`,
    });
  }

  return {
    ok: issue_count === 0,
    checked_at: nowIso(),
    assets: assets.length,
    versions,
    files,
    fts,
    issue_count,
    issues,
    truncated: issue_count > issues.length,
  };
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

/** knowledge-20261113T090000Z.db：UTC、精确到秒、不含冒号（Windows 也能落）。 */
function backupName(at: Date): string {
  return `knowledge-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.db`;
}

/**
 * `VACUUM INTO` 一份一致性副本到 `dir`（blueprint §5：不直接拷贝运行中的 db 文件）。
 * VACUUM 不能在事务里执行，调用方不要把它包进 withTx。同名文件已存在即拒绝。
 */
export function createBackup(db: Db, actor: User, dir: string, at = new Date()): BackupInfo {
  requireSystemAdmin(actor);
  const file = backupName(at);
  const path = join(dir, file);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) throw alreadyExists(`backup already exists: ${file}`);
  backupTo(db, path);
  return { file, path, bytes: statSync(path).size, created_at: at.toISOString() };
}
