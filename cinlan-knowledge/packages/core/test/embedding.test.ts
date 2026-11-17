import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, currentVersion, openDatabase, vecAvailable } from "../src/db.js";
import { addMember, createTeam, createUser, type User } from "../src/meta.js";
import { applyVisibility, createAsset, planVisibility, updateAsset } from "../src/asset.js";
import { searchAssets } from "../src/search.js";
import { deleteEmbeddings, ensureVec0, putEmbeddings, vecTableExists } from "../src/embedding.js";
import { DomainError } from "../src/errors.js";
import type { Principal } from "../src/access.js";

/**
 * O-9 向量检索 core 层：迁移 0002、vec0 机会式建表、embedding 存取、
 * searchAssets 双路（FTS + KNN）与 RRF 融合。全部用 float[4] 假向量，不调真模型。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-embedding-"));
}

function cleanup(dir: string): void {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") return;
    }
  }
}

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  dir: string;
  alice: User;
  outsider: User;
  team: ReturnType<typeof createTeam>;
}

function fixture(): Fixture {
  const dir = tempDir();
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const outsider = createUser(db, { name: "out", display_name: "Out" });
  const team = createTeam(db, sa, { name: "demo", title: "Demo" });
  addMember(db, sa, team, alice);
  return { db, dir, alice, outsider, team };
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

/** fixture 里补 team 引用给类型用 */
function makeAsset(db: Fixture["db"], who: User, teamId: string, title: string, content: string) {
  return createAsset(db, as(who), teamId, { type: "memory", title, content, layer: "core" }).asset;
}

test("migration 0002 applied, vec0 opportunistically creatable, extension loaded", () => {
  const { db, dir } = fixture();
  try {
    assert.equal(currentVersion(db), 2);
    assert.ok(vecAvailable(db), "sqlite-vec should load on this platform");
    assert.equal(vecTableExists(db), false, "vec0 is not created by the versioned migration");
    assert.equal(ensureVec0(db, 4), true);
    assert.equal(vecTableExists(db), true);
    // 幂等
    assert.equal(ensureVec0(db, 4), true);
  } finally {
    closeDatabase(db);
    cleanup(dir);
  }
});

test("vec0 survives reopen (file db, extension is per-connection)", () => {
  const { db, dir } = fixture();
  ensureVec0(db, 4);
  closeDatabase(db);
  try {
    const db2 = openDatabase({ file: join(dir, "knowledge.db") });
    assert.equal(vecTableExists(db2), true);
    closeDatabase(db2);
  } finally {
    cleanup(dir);
  }
});

test("putEmbeddings → knn order; delete removes; validation errors", () => {
  const { db, dir, alice, team } = fixture();
  try {
    ensureVec0(db, 4);
    const a1 = makeAsset(db, alice, team.id, "甲", "甲内容");
    const a2 = makeAsset(db, alice, team.id, "乙", "乙内容");
    putEmbeddings(db, {
      asset_id: a1.id,
      version: 1,
      model: "fake",
      vectors: [[0.1, 0.2, 0.3, 0.4]],
    });
    putEmbeddings(db, {
      asset_id: a2.id,
      version: 1,
      model: "fake",
      vectors: [[0.9, 0.8, 0.7, 0.6]],
    });
    // 覆盖式重写：a1 换向量
    putEmbeddings(db, {
      asset_id: a1.id,
      version: 2,
      model: "fake",
      vectors: [[0.9, 0.85, 0.75, 0.65]],
    });
    const hits = db
      .prepare(
        `SELECT ec.asset_id AS asset_id, v.distance AS distance
           FROM (SELECT rowid, distance FROM embedding_vec WHERE embedding MATCH ? AND k = CAST(? AS INTEGER)) v
           JOIN embedding_chunk ec ON ec.id = v.rowid ORDER BY v.distance`,
      )
      .all(Buffer.from(new Float32Array([0.9, 0.8, 0.7, 0.6]).buffer), 2) as { asset_id: string; distance: number }[];
    assert.equal(hits.length, 2, "overwrite keeps exactly one row per asset");
    assert.ok(hits[0]!.asset_id === a1.id || hits[0]!.asset_id === a2.id);
    assert.ok(hits[0]!.distance <= hits[1]!.distance);

    deleteEmbeddings(db, a1.id);
    const after = db.prepare("SELECT COUNT(*) AS n FROM embedding_chunk").get() as { n: number };
    assert.equal(after.n, 1, "deleteEmbeddings removes chunks for the asset");

    assert.throws(() => putEmbeddings(db, { asset_id: a2.id, version: 1, model: "fake", vectors: [] }), DomainError);
    assert.throws(
      () => putEmbeddings(db, { asset_id: a2.id, version: 1, model: "fake", vectors: [[0.1, 0.2], [0.3]] }),
      DomainError,
      "vectors must share dims",
    );
  } finally {
    closeDatabase(db);
    cleanup(dir);
  }
});

test("searchAssets dual-path: semantic hit beyond lexical + RRF promotes the both-paths hit", () => {
  const { db, dir, alice, outsider, team } = fixture();
  try {
    ensureVec0(db, 4);
    const duty = makeAsset(db, alice, team.id, "值班响应约定", "夜间 P0 告警先看 hub 日志，十分钟内留痕。");
    const release = makeAsset(db, alice, team.id, "发版检查清单", "发布前跑全部测试，再翻 releases/current。");
    for (const [asset, vec] of [
      [duty, [1, 0, 0, 0]],
      [release, [0, 1, 0, 0]],
    ] as const) {
      // 共享到团队（review_mode 默认 share 会开审批，直接 applyVisibility 模拟已批准状态）
      const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
      applyVisibility(db, asset, plan.plan, alice.id);
      putEmbeddings(db, { asset_id: asset.id, version: 1, model: "fake", vectors: [vec as unknown as number[]] });
    }

    // 1) 纯语义：词法完全不命中（「深夜」不在任何文本里），排序由向量决定——值班第一
    //    （KNN 是 top-k 不是阈值，弱相关的发版排在第二属预期）
    const semantic = searchAssets(db, as(alice), { query: "深夜", query_embedding: [0.99, 0.05, 0, 0] });
    assert.equal(semantic.hits.length, 2);
    assert.equal(semantic.hits[0]!.asset_id, duty.id);

    // 2) RRF：两路都命中「告警」（FTS 命中值班正文）+ 向量也靠近值班 → 值班第一
    const fused = searchAssets(db, as(alice), { query: "告警", query_embedding: [0.9, 0.2, 0, 0] });
    assert.equal(fused.hits[0]!.asset_id, duty.id);
    assert.ok(fused.hits[0]!.score > 0, "RRF score present");

    // 3) 权限：局外人带向量也拿不到任何东西
    const outside = searchAssets(db, as(outsider), { query: "告警", query_embedding: [0.9, 0.2, 0, 0] });
    assert.equal(outside.hits.length, 0);

    // 4) 陈旧向量不参与检索：资产升 v2（内容追加）、embedding 仍指 v1 → duty 被向量路排除
    updateAsset(db, as(alice), duty, { base_version: 1, title: duty.title, content: "夜间 P0 告警先看 hub 日志，十分钟内留痕。升级版。" });
    const afterVersion = searchAssets(db, as(alice), { query: "深夜", query_embedding: [0.99, 0.05, 0, 0] });
    assert.equal(afterVersion.hits[0]!.asset_id, release.id, "stale embedding (v1 vs current v2) must be excluded");
    // 补上新版本的向量 → duty 回到第一
    putEmbeddings(db, { asset_id: duty.id, version: 2, model: "fake", vectors: [[1, 0, 0, 0]] });
    const refreshed = searchAssets(db, as(alice), { query: "深夜", query_embedding: [0.99, 0.05, 0, 0] });
    assert.equal(refreshed.hits[0]!.asset_id, duty.id);

    // 5) 显式带向量但索引没建：明确报错而不是静默退化
    deleteEmbeddings(db, duty.id);
    db.exec("DROP TABLE embedding_vec");
    assert.throws(
      () => searchAssets(db, as(alice), { query: "告警", query_embedding: [0.9, 0.2, 0, 0] }),
      (err: unknown) => err instanceof DomainError && err.code === "INVALID_ARGUMENT",
    );
  } finally {
    closeDatabase(db);
    cleanup(dir);
  }
});

test("query_embedding validation: non-array / non-finite / oversize rejected", () => {
  const { db, dir, alice, team } = fixture();
  try {
    ensureVec0(db, 4);
    const asset = makeAsset(db, alice, team.id, "标题", "内容");
    putEmbeddings(db, { asset_id: asset.id, version: 1, model: "fake", vectors: [[0, 0, 0, 1]] });
    const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
    applyVisibility(db, asset, plan.plan, alice.id);
    for (const bad of ["nope", [1, "x", 3, 4], [Number.NaN], []]) {
      assert.throws(
        () => searchAssets(db, as(alice), { query: "标题", query_embedding: bad }),
        (err: unknown) => err instanceof DomainError && err.code === "INVALID_ARGUMENT",
        `query_embedding=${JSON.stringify(bad)} should be rejected`,
      );
    }
  } finally {
    closeDatabase(db);
    cleanup(dir);
  }
});
