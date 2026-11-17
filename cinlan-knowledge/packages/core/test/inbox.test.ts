import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createTeam, createUser, updateTeam, type User } from "../src/meta.js";
import { createAsset } from "../src/asset.js";
import { searchAssets } from "../src/search.js";
import { adoptDraft } from "../src/inbox.js";
import { requireRead } from "../src/access.js";
import { DomainError } from "../src/errors.js";
import type { Principal } from "../src/access.js";

/**
 * O-7 自动沉淀（core 层第一步）：createAsset 的 draft 入参 + adoptDraft 复合动作。
 * 验收对应 sop 241：草稿他人不可见，采纳后才可检索。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-inbox-"));
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
  bob: User;
  team: ReturnType<typeof createTeam>;
}

function fixture(reviewMode?: "off" | "share" | "all"): Fixture {
  const dir = tempDir();
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  let team = createTeam(db, sa, { name: "demo", title: "Demo" });
  if (reviewMode) team = updateTeam(db, sa, team, { review_mode: reviewMode });
  addMember(db, sa, team, alice);
  addMember(db, sa, team, bob);
  return { db, dir, alice, bob, team };
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

test("draft: invisible to others, absent from search, adopt (no visibility) makes it searchable", () => {
  const { db, dir, alice, bob, team } = fixture();
  try {
    const draft = createAsset(db, as(alice), team.id, {
      type: "memory",
      title: "值班响应约定",
      content: "夜间 P0 告警十分钟内响应。",
      status: "draft",
    });
    assert.equal(draft.asset.status, "draft");
    assert.equal(draft.asset.visibility, "private");

    // 他人不可见：bob 读不到（notFound）
    assert.throws(() => requireRead(db, as(bob), draft.asset), (err: unknown) => err instanceof DomainError && err.code === "NOT_FOUND");
    // 自己检索不可命中（draft 不进检索——即便 owner）
    assert.equal(searchAssets(db, as(alice), { query: "值班" }).hits.length, 0);
    assert.equal(searchAssets(db, as(bob), { query: "值班" }).hits.length, 0);

    // 采纳（不带可见性）：activate 直通
    const adopted = adoptDraft(db, as(alice), { asset_id: draft.asset.id });
    assert.equal(adopted.asset.status, "active");
    assert.equal(adopted.asset.visibility, "private");
    assert.equal(adopted.review, null);

    // 采纳后才可检索（owner 命中；bob 仍不可见——private）
    const mine = searchAssets(db, as(alice), { query: "值班" });
    assert.equal(mine.hits.length, 1);
    assert.equal(mine.hits[0]!.asset_id, draft.asset.id);
    assert.equal(searchAssets(db, as(bob), { query: "值班" }).hits.length, 0);
  } finally {
    closeDatabase(db);
    cleanup(dir);
  }
});

test("adopt with visibility=team: share review mode opens a review; off mode applies directly", () => {
  // 默认（share）团队：采纳 + 申请共享 → 进审批，资产保持 private
  const share = fixture();
  try {
    const draft = createAsset(share.db, as(share.alice), share.team.id, {
      type: "memory",
      title: "发版检查清单",
      content: "发布前跑全部测试。",
      status: "draft",
    });
    const out = adoptDraft(share.db, as(share.alice), { asset_id: draft.asset.id, visibility: "team", note: "全员都要" });
    assert.equal(out.review !== null, true, "share mode should open a review");
    assert.equal(out.asset.status, "active");
    assert.equal(out.asset.visibility, "private", "asset stays private while the share review is pending");
    // 重复采纳：已不是 draft
    assert.throws(
      () => adoptDraft(share.db, as(share.alice), { asset_id: draft.asset.id }),
      (err: unknown) => err instanceof DomainError && err.code === "INVALID_ARGUMENT",
    );
  } finally {
    closeDatabase(share.db);
    cleanup(share.dir);
  }

  // off 团队：直接生效
  const off = fixture("off");
  try {
    const draft = createAsset(off.db, as(off.alice), off.team.id, {
      type: "memory",
      title: "接口错误码总表",
      content: "0 INTERNAL / 401 UNAUTHORIZED。",
      status: "draft",
    });
    const out = adoptDraft(off.db, as(off.alice), { asset_id: draft.asset.id, visibility: "team" });
    assert.equal(out.review, null);
    assert.equal(out.asset.visibility, "team");
    // 团队成员现在检索得到
    assert.equal(searchAssets(off.db, as(off.bob), { query: "错误码" }).hits.length, 1);
  } finally {
    closeDatabase(off.db);
    cleanup(off.dir);
  }
});

test("createAsset rejects nonsense status; draft adopts cannot be forced by others", () => {
  const { db, dir, alice, bob, team } = fixture();
  try {
    assert.throws(
      () =>
        createAsset(db, as(alice), team.id, {
          type: "memory",
          title: "x",
          content: "y",
          status: "archived" as never,
        }),
      (err: unknown) => err instanceof DomainError,
      "status on create must be active | draft",
    );
    const draft = createAsset(db, as(alice), team.id, { type: "memory", title: "t", content: "c", status: "draft" });
    // bob（同队成员）既读不到草稿，也无权采纳
    assert.throws(
      () => adoptDraft(db, as(bob), { asset_id: draft.asset.id }),
      (err: unknown) => err instanceof DomainError,
    );
  } finally {
    closeDatabase(db);
    cleanup(dir);
  }
});
