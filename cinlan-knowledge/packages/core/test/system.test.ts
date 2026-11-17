import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrityIssue, IntegrityReport } from "@cinlan/knowledge-sdk";
import { closeDatabase, openDatabase, type Db } from "../src/db.js";
import { addMember, archiveAgent, createAgent, createTeam, createUser, setUserDisabled, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import { applyStatus, createAsset, planVisibility, updateAsset } from "../src/asset.js";
import { setVisibilityThroughGate, updateThroughGate } from "../src/review.js";
import { reportUsage } from "../src/usage.js";
import { writeAudit } from "../src/audit.js";
import { searchAssets } from "../src/search.js";
import { checkIntegrity, createBackup, systemStats } from "../src/system.js";
import type { Principal } from "../src/access.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-system-"));
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

function expectDomain(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    assert.equal((err as DomainError).code, code);
    return;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

const SKILL_MD = `---
name: deploy-release
description: 发版流程
---

# Deploy

先跑 e2e。`;

const RUN_SH = "#!/bin/sh\necho deploy\n";
const NOTES = "回滚：翻回 symlink";

/** 一个把各类行都摆出来的库：多版本、改过标签、带附件的 skill、已归档、待审提议。 */
function seed(dir: string) {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const carol = createUser(db, { name: "carol", display_name: "Carol" });
  setUserDisabled(db, sa, carol, true);
  const team = createTeam(db, sa, { name: "demo", title: "Demo" });
  createTeam(db, sa, { name: "empty", title: "Empty" });
  addMember(db, sa, team, alice, "admin");
  addMember(db, sa, team, bob);
  createAgent(db, alice, team, { name: "tmpl", host: "claude-code", is_template: true });
  const agent = createAgent(db, alice, team, { name: "cc-alice", host: "claude-code" });
  archiveAgent(db, bob, createAgent(db, bob, team, { name: "cc-bob", host: "codex" }));

  // 三个版本：改正文 → v2，改标签 → v3。v1 / v2 的 hash 是按旧标签算的
  const note = createAsset(db, as(alice), team.id, {
    type: "memory",
    title: "部署约定",
    content: "发版前先跑 e2e",
    layer: "core",
  }).asset;
  updateAsset(db, as(alice), note, { base_version: 1, content: "发版前先跑 e2e 与冒烟" });
  updateAsset(db, as(alice), note, { base_version: 2, tags: ["ops"] });

  // skill 带两个附属文件；改正文不重传 files → v2 沿用（文件行各存一份）
  const skill = createAsset(db, as(alice), team.id, {
    type: "skill",
    name: "deploy-release",
    title: "发版",
    content: SKILL_MD,
    files: [
      { path: "scripts/run.sh", encoding: "utf8", content: RUN_SH },
      { path: "docs/notes.md", encoding: "utf8", content: NOTES },
    ],
  }).asset;
  updateAsset(db, as(alice), skill, { base_version: 1, content: `${SKILL_MD}\n再看监控。` });

  // 已归档：不在检索里
  const retired = createAsset(db, as(bob), team.id, { type: "memory", title: "旧流程", content: "已废弃的做法" }).asset;
  applyStatus(db, retired, "archived");

  // 团队可见（alice 是 TA，自批）+ bob 的一条待审提议（proposed 版本行）
  const shared = createAsset(db, as(alice), team.id, { type: "memory", title: "值班表", content: "周一 alice" }).asset;
  const { plan, elevates } = planVisibility(db, as(alice), shared, { visibility: "team" });
  assert.equal(setVisibilityThroughGate(db, as(alice), shared, plan, elevates).applied, true);
  assert.equal(updateThroughGate(db, as(bob), shared, { base_version: 1, content: "周一 alice，周二 bob" }).applied, false);

  reportUsage(db, as(alice), {
    agent_id: agent.id,
    events: [
      { asset_id: note.id, version: 3, kind: "injected" },
      { asset_id: shared.id, version: 1, kind: "injected" },
    ],
  });
  writeAudit(db, { action: "asset/create", actor_user_id: alice.id, target_type: "asset", target_id: note.id });
  return { db, sa, alice, bob, team, note, skill, retired, shared };
}

function seqOf(db: Db, asset_id: string): number {
  return (db.prepare("SELECT seq FROM asset WHERE id = ?").get(asset_id) as { seq: number }).seq;
}

test("system: stats counts the whole inventory, SA only", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice } = seed(dir);
    const stats = systemStats(db, sa);
    assert.match(stats.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(stats.schema_version, 2);
    assert.ok(Number.isInteger(stats.db_bytes) && stats.db_bytes > 0);
    assert.deepEqual(stats.users, { total: 4, active: 3, disabled: 1 });
    assert.equal(stats.teams, 2);
    assert.deepEqual(stats.agents, { total: 3, active: 2, archived: 1, templates: 1 });
    assert.deepEqual(stats.assets, {
      total: 4,
      by_type: { memory: 3, skill: 1, wiki: 0, codegraph: 0 },
      by_status: { draft: 0, active: 3, deprecated: 0, archived: 1 },
      // 种子资产全部没有 expires_at
      expired: 0,
      expiring_7d: 0,
    });
    // note 3 + skill 2 + retired 1 + shared 2（含 proposed）
    assert.equal(stats.versions, 8);
    const perVersion = Buffer.byteLength(RUN_SH) + Buffer.byteLength(NOTES);
    assert.deepEqual(stats.files, { total: 4, bytes: perVersion * 2 });
    assert.deepEqual(stats.reviews, { total: 2, pending: 1 });
    assert.equal(stats.usage_rows, 2);
    assert.equal(stats.audit_rows, 1);

    // TA 不是 SA
    expectDomain(() => systemStats(db, alice), "FORBIDDEN");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("system: integrity recomputes with the write-time hash function and reports each kind of damage", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, note, skill, retired, shared } = seed(dir);

    const healthy: Omit<IntegrityReport, "checked_at"> = {
      ok: true,
      assets: 4,
      // note 的 v1 / v2 是改标签之前的版本：标签进了 hash 却没随版本留快照，复算不出来，不算不一致
      versions: { total: 8, verified: 6, unverifiable: 2, mismatched: 0 },
      files: { total: 4, mismatched: 0 },
      fts: { indexed: 3, missing: 0, stale: 0, orphaned: 0 },
      issue_count: 0,
      issues: [],
      truncated: false,
    };
    const check = (): Omit<IntegrityReport, "checked_at"> => {
      const { checked_at, ...rest } = checkIntegrity(db, sa);
      assert.match(checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      return rest;
    };
    /** 弄坏一处 → 报告里恰好多出这一条；复原后回到全绿。 */
    const damaged = (
      breakIt: () => void,
      restore: () => void,
      issue: IntegrityIssue,
      counters: Partial<Pick<IntegrityReport, "versions" | "files" | "fts">>,
    ): void => {
      breakIt();
      assert.deepEqual(check(), { ...healthy, ...counters, ok: false, issue_count: 1, issues: [issue] });
      restore();
      assert.deepEqual(check(), healthy);
    };

    assert.deepEqual(check(), healthy);

    // 现行版本的 hash 对不上
    const noteHash = (db.prepare("SELECT content_hash AS h FROM asset_version WHERE asset_id = ? AND version = 3").get(note.id) as { h: string }).h;
    damaged(
      () => db.prepare("UPDATE asset_version SET content_hash = ? WHERE asset_id = ? AND version = 3").run("0".repeat(64), note.id),
      () => db.prepare("UPDATE asset_version SET content_hash = ? WHERE asset_id = ? AND version = 3").run(noteHash, note.id),
      { kind: "hash_mismatch", asset_id: note.id, version: 3, path: null, detail: "content_hash differs from the recomputed value" },
      { versions: { total: 8, verified: 5, unverifiable: 2, mismatched: 1 } },
    );

    // 附属文件的数据被改：版本 hash 用的是登记的 sha256，仍然对得上，只报文件
    damaged(
      () => db.prepare("UPDATE asset_file SET data = ? WHERE asset_id = ? AND version = 2 AND path = 'scripts/run.sh'").run(Buffer.from("rm -rf /"), skill.id),
      () => db.prepare("UPDATE asset_file SET data = ? WHERE asset_id = ? AND version = 2 AND path = 'scripts/run.sh'").run(Buffer.from(RUN_SH), skill.id),
      { kind: "file_mismatch", asset_id: skill.id, version: 2, path: "scripts/run.sh", detail: "stored sha256 / bytes differ from the file data" },
      { files: { total: 4, mismatched: 1 } },
    );

    // 检索行丢失 / 与现行版本不一致
    const noteSeq = seqOf(db, note.id);
    const row = db.prepare("SELECT title, tags, summary, body FROM asset_fts WHERE rowid = ?").get(noteSeq) as {
      title: string;
      tags: string;
      summary: string;
      body: string;
    };
    const reinsert = (): void => {
      db.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(noteSeq);
      db.prepare("INSERT INTO asset_fts (rowid, title, tags, summary, body) VALUES (?, ?, ?, ?, ?)").run(
        noteSeq,
        row.title,
        row.tags,
        row.summary,
        row.body,
      );
    };
    damaged(
      () => db.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(noteSeq),
      reinsert,
      { kind: "fts_missing", asset_id: note.id, version: 3, path: null, detail: "asset has no search row" },
      { fts: { indexed: 2, missing: 1, stale: 0, orphaned: 0 } },
    );
    damaged(
      () => db.prepare("UPDATE asset_fts SET body = ? WHERE rowid = ?").run("别的资产的正文", noteSeq),
      reinsert,
      { kind: "fts_stale", asset_id: note.id, version: 3, path: null, detail: "search row differs from the current version" },
      { fts: { indexed: 3, missing: 0, stale: 1, orphaned: 0 } },
    );

    // 检索行没有主：归档资产仍在索引里 / rowid 对不上任何资产
    const retiredSeq = seqOf(db, retired.id);
    damaged(
      () => db.prepare("INSERT INTO asset_fts (rowid, title, tags, summary, body) VALUES (?, 't', '', '', 'b')").run(retiredSeq),
      () => db.prepare("DELETE FROM asset_fts WHERE rowid = ?").run(retiredSeq),
      { kind: "fts_orphan", asset_id: retired.id, version: null, path: null, detail: "archived asset is still indexed" },
      { fts: { indexed: 4, missing: 0, stale: 0, orphaned: 1 } },
    );
    damaged(
      () => db.prepare("INSERT INTO asset_fts (rowid, title, tags, summary, body) VALUES (9999, 't', '', '', 'b')").run(),
      () => db.prepare("DELETE FROM asset_fts WHERE rowid = 9999").run(),
      { kind: "fts_orphan", asset_id: null, version: null, path: null, detail: "search row 9999 has no asset" },
      { fts: { indexed: 4, missing: 0, stale: 0, orphaned: 1 } },
    );

    // current_version 指向不存在的行 / 指向未提交的 proposed 行（shared 的 v2）
    damaged(
      () => db.prepare("UPDATE asset SET current_version = 9 WHERE id = ?").run(retired.id),
      () => db.prepare("UPDATE asset SET current_version = 1 WHERE id = ?").run(retired.id),
      { kind: "dangling_version", asset_id: retired.id, version: 9, path: null, detail: "current_version has no committed version row" },
      {},
    );
    damaged(
      () => db.prepare("UPDATE asset SET current_version = 2 WHERE id = ?").run(shared.id),
      () => db.prepare("UPDATE asset SET current_version = 1 WHERE id = ?").run(shared.id),
      { kind: "dangling_version", asset_id: shared.id, version: 2, path: null, detail: "current_version has no committed version row" },
      {},
    );

    // 问题很多时只回前 200 条，计数仍是全量
    for (let i = 0; i < 201; i++) {
      db.prepare("INSERT INTO asset_fts (rowid, title, tags, summary, body) VALUES (?, 't', '', '', 'b')").run(10000 + i);
    }
    const flooded = checkIntegrity(db, sa);
    assert.equal(flooded.ok, false);
    assert.equal(flooded.issue_count, 201);
    assert.equal(flooded.issues.length, 200);
    assert.equal(flooded.truncated, true);
    assert.equal(flooded.fts.orphaned, 201);
    db.prepare("DELETE FROM asset_fts WHERE rowid >= 10000").run();
    assert.deepEqual(check(), healthy);

    expectDomain(() => checkIntegrity(db, alice), "FORBIDDEN");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("system: backup is a VACUUM INTO copy that never overwrites and passes integrity on its own", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, note } = seed(dir);
    const out = join(dir, "backups");
    const at = new Date("2026-11-13T09:00:00.000Z");

    // 非 SA：拒绝，且连目录都不建
    expectDomain(() => createBackup(db, alice, out, at), "FORBIDDEN");
    assert.equal(existsSync(out), false);

    const info = createBackup(db, sa, out, at);
    assert.equal(info.file, "knowledge-20261113T090000Z.db");
    assert.equal(info.path, join(out, info.file));
    assert.equal(info.created_at, "2026-11-13T09:00:00.000Z");
    assert.ok(info.bytes > 0);
    assert.equal(info.bytes, statSync(info.path).size);
    assert.deepEqual(readdirSync(out), [info.file]);

    // 同名不覆盖；换个时刻是另一份
    expectDomain(() => createBackup(db, sa, out, at), "ALREADY_EXISTS");
    assert.equal(statSync(info.path).size, info.bytes);
    assert.equal(createBackup(db, sa, out, new Date("2026-11-13T09:00:01.000Z")).file, "knowledge-20261113T090001Z.db");

    // 副本独立可用：复算全绿，seq 与检索不串位（D-21）
    const live = checkIntegrity(db, sa);
    const liveSeq = db.prepare("SELECT id, seq FROM asset ORDER BY seq").all();
    const copy = openDatabase({ file: info.path });
    try {
      const report = checkIntegrity(copy, sa);
      assert.equal(report.ok, true);
      assert.deepEqual(report.versions, live.versions);
      assert.deepEqual(report.files, live.files);
      assert.deepEqual(report.fts, live.fts);
      assert.deepEqual(copy.prepare("SELECT id, seq FROM asset ORDER BY seq").all(), liveSeq);
      const hits = searchAssets(copy, as(alice), { query: "冒烟" }).hits;
      assert.deepEqual(hits.map((h) => h.asset_id), [note.id]);
    } finally {
      closeDatabase(copy);
    }
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
