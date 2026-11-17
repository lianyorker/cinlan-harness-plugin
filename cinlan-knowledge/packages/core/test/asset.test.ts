import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createTeam, createUser, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import {
  applyStatus,
  applyVisibility,
  createAsset,
  getAssetDetail,
  getHistory,
  grantAcl,
  listAcl,
  listAssets,
  normalizeFiles,
  parseSkillFrontmatter,
  planVisibility,
  proposeUpdate,
  purgeAsset,
  revokeAcl,
  updateAsset,
  validSkillPath,
} from "../src/asset.js";
import { Validator } from "../src/validate.js";
import type { Principal } from "../src/access.js";
import { searchAssets } from "../src/search.js";
import { checkIntegrity } from "../src/system.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-asset-"));
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

function expectDomain(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DomainError, `expected DomainError, got ${String(err)}`);
    assert.equal((err as DomainError).code, code);
    return err as DomainError;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
}

const SKILL_MD = `---
name: deploy-release
description: 发版流程
---

# Deploy

先跑 e2e。`;

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  sa: User;
  alice: User;
  bob: User;
  outsider: User;
  team: ReturnType<typeof createTeam>;
}

function fixture(dir: string): Fixture {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const outsider = createUser(db, { name: "out", display_name: "Out" });
  const team = createTeam(db, sa, { name: "demo", title: "Demo" });
  addMember(db, sa, team, alice);
  addMember(db, sa, team, bob);
  return { db, sa, alice, bob, outsider, team };
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

test("asset: create is private + active + v1, unique per (team,type,owner,name)", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team, outsider } = fixture(dir);
    const { asset, version, files } = createAsset(db, as(alice), team.id, {
      type: "memory",
      title: "发版检查清单",
      content: "发布前先跑 e2e",
      tags: ["release", "release", "ops"],
      layer: "atom",
    });
    assert.match(asset.id, /^ast_[0-9a-f]{24}$/);
    assert.equal(asset.visibility, "private");
    assert.equal(asset.status, "active");
    assert.equal(asset.current_version, 1);
    assert.equal(version.state, "committed");
    assert.equal(version.version, 1);
    assert.equal(files.length, 0);
    // tags 去重排序
    assert.deepEqual(asset.tags, ["ops", "release"]);
    assert.match(version.content_hash, /^[0-9a-f]{64}$/);

    // 团队外的人建不了；看不到团队即 NOT_FOUND
    expectDomain(
      () => createAsset(db, as(outsider), team.id, { type: "memory", title: "x", content: "y" }),
      "NOT_FOUND",
    );

    // skill 重名：同一 owner 同团队 409，别人可以同名（各自私有）
    createAsset(db, as(alice), team.id, { type: "skill", name: "deploy-release", title: "S", content: SKILL_MD });
    expectDomain(
      () => createAsset(db, as(alice), team.id, { type: "skill", name: "deploy-release", title: "S2", content: SKILL_MD }),
      "ALREADY_EXISTS",
    );
    createAsset(db, as(bob), team.id, { type: "skill", name: "deploy-release", title: "B", content: SKILL_MD });
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: SKILL.md frontmatter and file paths are validated", () => {
  const dir = tempDir();
  try {
    const { db, alice, team } = fixture(dir);
    const err = expectDomain(
      () =>
        createAsset(db, as(alice), team.id, {
          type: "skill",
          name: "deploy-release",
          title: "S",
          content: "no frontmatter here",
        }),
      "INVALID_ARGUMENT",
    );
    assert.ok((err.data["issues"] as string[]).some((i) => i.includes("frontmatter")));

    expectDomain(
      () =>
        createAsset(db, as(alice), team.id, {
          type: "skill",
          name: "deploy-release",
          title: "S",
          content: SKILL_MD.replace("name: deploy-release", "name: other"),
        }),
      "INVALID_ARGUMENT",
    );

    // 路径穿越 / 反斜杠 / 绝对路径 / 盘符 一律拒绝
    for (const bad of ["../x.sh", "a\\b.sh", "/etc/passwd", "C:/x.sh", "a//b", "./a"]) {
      assert.equal(validSkillPath(bad), false, bad);
    }
    assert.equal(validSkillPath("scripts/run.sh"), true);

    const v = new Validator();
    normalizeFiles(v, [{ path: "../evil.sh", encoding: "utf8", content: "rm -rf /" }]);
    normalizeFiles(v, [
      { path: "a.sh", encoding: "utf8", content: "x" },
      { path: "a.sh", encoding: "utf8", content: "y" },
    ]);
    normalizeFiles(v, [{ path: "SKILL.md", encoding: "utf8", content: "x" }]);
    assert.equal(v.issues.length, 3);

    const ok = createAsset(db, as(alice), team.id, {
      type: "skill",
      name: "deploy-release",
      title: "S",
      content: SKILL_MD,
      files: [
        { path: "scripts/run.sh", encoding: "utf8", content: "echo hi" },
        { path: "assets/logo.bin", encoding: "base64", content: Buffer.from([0, 1, 2]).toString("base64") },
      ],
    });
    const detail = getAssetDetail(db, as(alice), ok.asset.id);
    assert.equal(detail.version.version, 1);
    const file = getAssetDetail(db, as(alice), ok.asset.id, undefined, "scripts/run.sh").file!;
    assert.equal(Buffer.from(file.content, "base64").toString("utf8"), "echo hi");
    assert.equal(parseSkillFrontmatter(SKILL_MD)!.name, "deploy-release");
    // CRLF 换行的 SKILL.md（Windows 本机常态）也要能解析
    const crlf = SKILL_MD.replaceAll("\n", "\r\n");
    assert.deepEqual(parseSkillFrontmatter(crlf), parseSkillFrontmatter(SKILL_MD));
    // 未知路径按不存在处理
    expectDomain(() => getAssetDetail(db, as(alice), ok.asset.id, undefined, "nope.sh"), "NOT_FOUND");

    // memory 不接受 files
    expectDomain(
      () =>
        createAsset(db, as(alice), team.id, {
          type: "memory",
          title: "M",
          content: "c",
          files: [{ path: "a.sh", encoding: "utf8", content: "x" }],
        }),
      "INVALID_ARGUMENT",
    );

    // skill 更新未重传 files：沿用现行版本的文件（data 一起带过去）
    updateAsset(db, as(alice), ok.asset, { base_version: 1, title: "S2" });
    const carried = getAssetDetail(db, as(alice), ok.asset.id, 2, "scripts/run.sh").file!;
    assert.equal(Buffer.from(carried.content, "base64").toString("utf8"), "echo hi");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: frontmatter 的块标量——`>` 折叠、`|` 保留换行、空块按缺 description 拒收", () => {
  const folded = [
    "---",
    "name: deploy-release",
    "description: >-",
    "  Use when shipping",
    "  a release.",
    "",
    "  Second paragraph.",
    "license: MIT",
    "---",
    "",
    "# Deploy",
  ].join("\n");
  assert.deepEqual(parseSkillFrontmatter(folded), {
    name: "deploy-release",
    description: "Use when shipping a release.\nSecond paragraph.",
  });
  assert.deepEqual(parseSkillFrontmatter(folded.replaceAll("\n", "\r\n")), parseSkillFrontmatter(folded));
  // `>` 不带收尾符、`|` 系列同样认；`|` 不折行
  assert.equal(parseSkillFrontmatter(folded.replace(">-", ">"))!.description, "Use when shipping a release.\nSecond paragraph.");
  const literal = "---\nname: deploy-release\ndescription: |\n  line one\n    indented\n  line two\n---\n";
  assert.equal(parseSkillFrontmatter(literal)!.description, "line one\n  indented\nline two");
  // 块标量后面没有缩进的正文 = description 为空
  assert.equal(parseSkillFrontmatter("---\nname: deploy-release\ndescription: >-\n---\n"), null);
  assert.equal(parseSkillFrontmatter("---\nname: deploy-release\ndescription: >-\nlicense: MIT\n---\n"), null);

  const dir = tempDir();
  try {
    const { db, alice, team } = fixture(dir);
    const ok = createAsset(db, as(alice), team.id, { type: "skill", name: "deploy-release", title: "S", content: folded });
    assert.equal(ok.asset.name, "deploy-release");
    const err = expectDomain(
      () =>
        createAsset(db, as(alice), team.id, {
          type: "skill",
          name: "empty-desc",
          title: "S",
          content: "---\nname: empty-desc\ndescription: >-\n---\n\nbody\n",
        }),
      "INVALID_ARGUMENT",
    );
    assert.ok((err.data["issues"] as string[]).some((i) => i.includes("frontmatter")));
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: update is versioned, idempotent, and rejects stale base_version", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team } = fixture(dir);
    const created = createAsset(db, as(alice), team.id, { type: "memory", title: "T", content: "v1" });
    const { asset } = created;
    const first = updateAsset(db, as(alice), asset, { base_version: 1, content: "v2", change_note: "补" });
    assert.deepEqual(first, { changed: true, version: 2 });

    // 内容与元数据都没变：不产生新版本
    const again = updateAsset(db, as(alice), asset, { base_version: 2, content: "v2" });
    assert.deepEqual(again, { changed: false, version: 2 });

    // 旧 base_version：409 且带 current_version
    const err = expectDomain(() => updateAsset(db, as(alice), asset, { base_version: 1, content: "v3" }), "VERSION_CONFLICT");
    assert.equal(err.data["current_version"], 2);

    // 标题变更也要建版本并同步 asset 行
    const renamed = updateAsset(db, as(alice), asset, { base_version: 2, title: "T2" });
    assert.equal(renamed.version, 3);
    assert.equal(getAssetDetail(db, as(alice), asset.id).asset.title, "T2");
    assert.equal(getHistory(db, as(alice), asset.id).length, 3);

    updateAsset(db, as(alice), asset, { base_version: 3, content: "alice-v4" });

    // 私有资产：成员连读都读不到，更谈不上提议
    expectDomain(() => proposeUpdate(db, as(bob), asset, { base_version: 4, content: "bob-v5" }), "NOT_FOUND");

    // 共享后：读者写 proposal → 新版本行是 proposed，不进 current，对外不可见
    const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
    applyVisibility(db, asset, plan.plan, alice.id);
    const p = proposeUpdate(db, as(bob), asset, { base_version: 4, content: "bob-v5" });
    assert.equal(p.version, 5);
    assert.equal(getAssetDetail(db, as(alice), asset.id).asset.current_version, 4);
    assert.equal(getHistory(db, as(bob), asset.id).filter((v) => v.state === "proposed").length, 0);
    assert.equal(getHistory(db, as(alice), asset.id).filter((v) => v.state === "proposed").length, 1);
    expectDomain(() => getAssetDetail(db, as(bob), asset.id, 5), "NOT_FOUND");

    // 只写 change_note、内容未变：同样不产生版本（4 committed + 1 proposed）
    updateAsset(db, as(alice), asset, { base_version: 4, change_note: "仅备注" });
    assert.equal(getHistory(db, as(alice), asset.id).length, 5);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: visibility elevation, restricted acl, same-name skill clash", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, outsider, team } = fixture(dir);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });

    // team：成员可见，团队外不可见
    const planR = planVisibility(db, as(alice), asset, { visibility: "team" });
    assert.equal(planR.elevates, true);
    const shared = applyVisibility(db, asset, planR.plan, alice.id);
    assert.equal(shared.visibility, "team");
    assert.equal(getAssetDetail(db, as(bob), asset.id).asset.id, asset.id);
    expectDomain(() => getAssetDetail(db, as(outsider), asset.id), "NOT_FOUND");

    // restricted 必须带 acl
    expectDomain(() => planVisibility(db, as(alice), shared, { visibility: "restricted" }), "INVALID_ARGUMENT");

    // 提为 restricted 且只授权 bob：alice 是 owner 仍可读，carol 类用户不可见
    const plan = planVisibility(db, as(alice), shared, {
      visibility: "restricted",
      acl: [{ subject_type: "user", subject_id: bob.id, permission: "read" }],
    });
    assert.equal(plan.elevates, false, "已是 team，不算提升");
    applyVisibility(db, shared, plan.plan, alice.id);
    assert.equal(listAcl(db, as(bob), shared).length, 1);
    assert.equal(getAssetDetail(db, as(bob), asset.id).asset.id, asset.id);
    expectDomain(() => getAssetDetail(db, as(outsider), asset.id), "NOT_FOUND");

    // 降级永远直通；restricted 之外的 acl 被清空
    const lower = planVisibility(db, as(alice), shared, { visibility: "private" });
    assert.equal(lower.elevates, false);
    applyVisibility(db, shared, lower.plan, alice.id);
    expectDomain(() => getAssetDetail(db, as(bob), asset.id), "NOT_FOUND");

    // 同名 skill 提升到团队：第二个 owner 撞名 409
    const s1 = createAsset(db, as(alice), team.id, {
      type: "skill",
      name: "dup",
      title: "A",
      content: SKILL_MD.replace("deploy-release", "dup"),
    });
    const s2 = createAsset(db, as(bob), team.id, {
      type: "skill",
      name: "dup",
      title: "B",
      content: SKILL_MD.replace("deploy-release", "dup"),
    });
    const p1 = planVisibility(db, as(alice), s1.asset, { visibility: "team" });
    applyVisibility(db, s1.asset, p1.plan, alice.id);
    const p2 = planVisibility(db, as(bob), s2.asset, { visibility: "team" });
    expectDomain(() => applyVisibility(db, s2.asset, p2.plan, bob.id), "ALREADY_EXISTS");
    assert.equal(getAssetDetail(db, as(bob), s2.asset.id).asset.visibility, "private");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: state machine and purge", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team } = fixture(dir);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });
    const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
    const shared = applyVisibility(db, asset, plan.plan, alice.id);

    // archived 只有管理者可见
    const archived = applyStatus(db, shared, "archived");
    assert.equal(archived.status, "archived");
    expectDomain(() => getAssetDetail(db, as(bob), asset.id), "NOT_FOUND");
    assert.equal(getAssetDetail(db, as(alice), asset.id).asset.status, "archived");

    // purge：非 archived 拒绝
    const other = createAsset(db, as(alice), team.id, { type: "memory", title: "M2", content: "c" });
    expectDomain(() => purgeAsset(db, as(alice), other.asset), "INVALID_ARGUMENT");

    // 归档后物理删除：版本 / 文件 / 检索行一并清掉
    purgeAsset(db, as(alice), archived);
    expectDomain(() => getAssetDetail(db, as(alice), asset.id), "NOT_FOUND");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM asset_version WHERE asset_id = ?").get(asset.id) as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM asset_fts WHERE rowid = ?").get(1) as { n: number }).n, 0);
    // purge 只有 owner / SA
    const s = applyStatus(db, other.asset, "archived");
    expectDomain(() => purgeAsset(db, as(bob), s), "FORBIDDEN");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: editing an archived asset keeps it out of the search index", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, team } = fixture(dir);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "归档条目", content: "旧的正文" });
    const archived = applyStatus(db, asset, "archived");
    const indexed = (): number => (db.prepare("SELECT COUNT(*) AS n FROM asset_fts").get() as { n: number }).n;
    assert.equal(indexed(), 0);

    // 管理者仍可改归档资产；改完依旧不进检索（data-model §4：archived 不检索）
    assert.deepEqual(updateAsset(db, as(alice), archived, { base_version: 1, content: "换过的正文" }), {
      changed: true,
      version: 2,
    });
    assert.equal(indexed(), 0);
    assert.equal(checkIntegrity(db, sa).ok, true);

    // 恢复时索引的是改过的那一版
    applyStatus(db, archived, "active");
    assert.deepEqual(
      searchAssets(db, as(alice), { query: "换过的正文" }).hits.map((h) => h.asset_id),
      [asset.id],
    );
    assert.equal(checkIntegrity(db, sa).ok, true);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("asset: list narrows by ACCESSIBLE_SQL and paginates", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, outsider, team } = fixture(dir);
    const mine = createAsset(db, as(alice), team.id, { type: "memory", title: "A1", content: "c" });
    createAsset(db, as(alice), team.id, { type: "memory", title: "A2", content: "c" });
    createAsset(db, as(bob), team.id, { type: "memory", title: "B1", content: "c" });

    // 私有：互相不可见
    assert.equal(listAssets(db, as(alice), {}).items.length, 2);
    assert.equal(listAssets(db, as(bob), {}).items.length, 1);
    assert.equal(listAssets(db, as(outsider), {}).items.length, 0);

    // 共享后 bob 可见；团队外仍不可见
    const plan = planVisibility(db, as(alice), mine.asset, { visibility: "team" });
    applyVisibility(db, mine.asset, plan.plan, alice.id);
    assert.equal(listAssets(db, as(bob), {}).items.length, 2);
    assert.equal(listAssets(db, as(outsider), {}).items.length, 0);

    // 分页：limit=1 两页翻完，cursor 为空结束
    const p1 = listAssets(db, as(alice), { limit: 1 });
    assert.equal(p1.items.length, 1);
    assert.equal(p1.next_cursor, "1");
    const p2 = listAssets(db, as(alice), { limit: 1, cursor: p1.next_cursor });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.next_cursor, "");
    expectDomain(() => listAssets(db, as(alice), { cursor: "abc" }), "INVALID_ARGUMENT");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("acl: grant is idempotent, revoke removes, visibility gate holds", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team } = fixture(dir);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });

    // 非 restricted 不允许加 acl
    expectDomain(
      () => grantAcl(db, as(alice), asset, { subject_type: "user", subject_id: bob.id, permission: "read" }),
      "INVALID_ARGUMENT",
    );

    const plan = planVisibility(db, as(alice), asset, {
      visibility: "restricted",
      acl: [{ subject_type: "user", subject_id: bob.id, permission: "read" }],
    });
    const restricted = applyVisibility(db, asset, plan.plan, alice.id);

    const g1 = grantAcl(db, as(alice), restricted, { subject_type: "user", subject_id: bob.id, permission: "read" });
    const g2 = grantAcl(db, as(alice), restricted, { subject_type: "user", subject_id: bob.id, permission: "read" });
    assert.equal(g2.created_at, g1.created_at, "grant 幂等");
    // 可读者能列 acl；只读者不能改
    assert.equal(listAcl(db, as(bob), restricted).length, 1);
    expectDomain(
      () => grantAcl(db, as(bob), restricted, { subject_type: "user", subject_id: bob.id, permission: "manage" }),
      "FORBIDDEN",
    );

    revokeAcl(db, as(alice), restricted, { subject_type: "user", subject_id: bob.id });
    expectDomain(
      () => revokeAcl(db, as(alice), restricted, { subject_type: "user", subject_id: bob.id }),
      "NOT_FOUND",
    );
    expectDomain(() => getAssetDetail(db, as(bob), asset.id), "NOT_FOUND");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
