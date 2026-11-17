import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import migration0001 from "./migrations/0001.js";
import migration0002 from "./migrations/0002.js";

/**
 * 全仓库唯一 import node:sqlite 的地方。
 * 迁移用 PRAGMA user_version 记账：每个迁移在 BEGIN IMMEDIATE 内执行并推进版本，失败回滚。
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [migration0001, migration0002];

export type Db = DatabaseSync;

export interface OpenOptions {
  /** 文件路径；":memory:" 用于测试 */
  file: string;
}

export function openDatabase(options: OpenOptions): Db {
  if (options.file !== ":memory:") {
    mkdirSync(dirname(options.file), { recursive: true });
  }
  const db = new DatabaseSync(options.file, { allowExtension: true });
  // WAL 对 :memory: 无效但无害
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  // sqlite-vec 机会式加载：平台没有预编译产物时照常启动（纯 FTS 模式，O-9）。
  // 扩展只活在连接期，不落盘；vec0 虚表由 embedding.ts 的 ensureVec0 补建。
  try {
    sqliteVec.load(db);
  } catch {
    // vecAvailable() 会如实报告 false
  }
  migrate(db);
  return db;
}

/** sqlite-vec 扩展在本连接上是否可用（openDatabase 已尽力加载）。 */
export function vecAvailable(db: Db): boolean {
  try {
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: unknown };
    return typeof row.v === "string";
  } catch {
    return false;
  }
}

export function currentVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: Db): number[] {
  const applied: number[] = [];
  const start = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= start) continue;
    if (m.version !== currentVersion(db) + 1) {
      throw new Error(`migration gap: want ${currentVersion(db) + 1}, got ${m.version}`);
    }
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version};`);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
    applied.push(m.version);
  }
  return applied;
}

/** 备份：单文件一致性快照。目标已存在则报错，不覆盖。 */
export function backupTo(db: Db, file: string): void {
  db.prepare("VACUUM INTO ?").run(file);
}

export function closeDatabase(db: Db): void {
  db.close();
}
