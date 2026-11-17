import type { Migration } from "../db.js";

/**
 * v2：向量检索的账面表。vec0 虚表（embedding_vec）不在这里建——它的创建依赖
 * sqlite-vec 扩展是否可用（openDatabase 里机会式加载），缺扩展的平台上 hub
 * 仍要以纯 FTS 模式启动。ensureVec0() 在扩展加载成功后补建虚表。
 * 阶段一分块策略：整条资产一个向量（seq_in_asset 恒 0），见 vector-search.md §4.1。
 */
const migration: Migration = {
  version: 2,
  name: "embedding-chunk",
  sql: `
CREATE TABLE embedding_chunk (
  id INTEGER PRIMARY KEY,
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  seq_in_asset INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES asset (id) ON DELETE CASCADE
);
CREATE INDEX idx_embedding_chunk_asset ON embedding_chunk (asset_id, version);
`,
};

export default migration;
