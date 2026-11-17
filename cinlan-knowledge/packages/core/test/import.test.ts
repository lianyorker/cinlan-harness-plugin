import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase, type Db } from "../src/db.js";
import { addMember, createTeam, createUser, updateTeam, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import { applyStatus, applyVisibility, getAssetDetail, getHistory, planVisibility, reloadAsset } from "../src/asset.js";
import { searchAssets } from "../src/search.js";
import { checkIntegrity } from "../src/system.js";
import { importSkill, type ImportSkillInput } from "../src/import.js";
import type { Principal } from "../src/access.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-import-"));
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

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: 提 PR 前逐项自查\n---\n\n${body}\n`;
}

/** 本机 `~/.claude/skills/pr-review` 的一份快照；用例只改要说的那一项。 */
function local(patch: Partial<ImportSkillInput> = {}): ImportSkillInput {
  return {
    name: "pr-review",
    title: "PR 评审清单",
    summary: "提 PR 前逐项自查",
    content: skillMd("pr-review", "1. 跑全量测试"),
    tags: ["review"],
    files: [{ path: "checklist.md", encoding: "utf8", content: "- [ ] 测试全绿\n" }],
    host: "claude-code",
    import_path: "/home/alice/.claude/skills/pr-review",
    ...patch,
  };
}

const EDITED = skillMd("pr-review", "1. 跑全量测试\n2. 自查 diff");

function fixture(dir: string) {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const outsider = createUser(db, { name: "out", display_name: "Out" });
  const team = createTeam(db, sa, { name: "demo", title: "Demo" });
  const other = createTeam(db, sa, { name: "other", title: "Other" });
  addMember(db, sa, team, alice);
  addMember(db, sa, team, bob);
  addMember(db, sa, other, alice);
  return { db, sa, alice, bob, outsider, team, other };
}

function rows(db: Db, table: "asset" | "asset_version" | "asset_file" | "asset_fts" | "review"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("import: a new skill lands as the caller's private asset; importing it again changes nothing", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, bob, team } = fixture(dir);
    const first = importSkill(db, as(alice), team.id, local());
    assert.equal(first.status, "created");
    assert.match(first.asset.id, /^ast_[0-9a-f]{24}$/);
    assert.match(first.asset.content_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(first.asset, {
      id: first.asset.id,
      name: "pr-review",
      title: "PR 评审清单",
      version: 1,
      content_hash: first.asset.content_hash,
      visibility: "private",
      status: "active",
      updated_at: first.asset.updated_at,
    });

    const det = getAssetDetail(db, as(alice), first.asset.id);
    assert.equal(det.asset.type, "skill");
    assert.equal(det.asset.owner_user_id, alice.id);
    assert.equal(det.asset.summary, "提 PR 前逐项自查");
    assert.deepEqual(det.asset.tags, ["review"]);
    // 出处照 data-model §9：origin = import，带宿主与本机路径
    assert.deepEqual(det.asset.source, {
      origin: "import",
      host: "claude-code",
      import_path: "/home/alice/.claude/skills/pr-review",
    });
    assert.equal(det.version.content, local().content);
    assert.equal(det.version.content_hash, first.asset.content_hash);
    assert.deepEqual(
      det.files?.map((f) => [f.path, f.bytes]),
      [["checklist.md", Buffer.byteLength("- [ ] 测试全绿\n")]],
    );

    // 恒为 private：同团队的人读不到，自己搜得到
    expectDomain(() => getAssetDetail(db, as(bob), first.asset.id), "NOT_FOUND");
    assert.deepEqual(
      searchAssets(db, as(alice), { query: "跑全量测试" }).hits.map((h) => h.asset_id),
      [first.asset.id],
    );

    // 再导一遍：内容相同 → unchanged，一行都不写（换了宿主与路径也一样，出处不改）
    const before = { asset: rows(db, "asset"), version: rows(db, "asset_version"), file: rows(db, "asset_file") };
    assert.deepEqual(importSkill(db, as(alice), team.id, local()), { status: "unchanged", asset: first.asset });
    assert.deepEqual(
      importSkill(db, as(alice), team.id, local({ host: "codex", import_path: "/home/alice/.agents/skills/pr-review" })),
      { status: "unchanged", asset: first.asset },
    );
    assert.deepEqual({ asset: rows(db, "asset"), version: rows(db, "asset_version"), file: rows(db, "asset_file") }, before);
    assert.equal(reloadAsset(db, first.asset.id).source.host, "claude-code");
    assert.equal(checkIntegrity(db, sa).ok, true);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("import: differing content is a conflict unless on_conflict asks for a new version", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, team } = fixture(dir);
    const first = importSkill(db, as(alice), team.id, local()).asset;

    // 默认：报 conflict，带现有资产的摘要，库不动
    assert.deepEqual(importSkill(db, as(alice), team.id, local({ content: EDITED })), { status: "conflict", asset: first });
    // 入参是整份快照：少给 tags / files 也算不同（它们都在 content_hash 里）
    assert.equal(importSkill(db, as(alice), team.id, local({ tags: undefined })).status, "conflict");
    assert.equal(importSkill(db, as(alice), team.id, local({ files: undefined })).status, "conflict");
    assert.equal(importSkill(db, as(alice), team.id, local({ title: "PR 自查" })).status, "conflict");
    assert.equal(rows(db, "asset_version"), 1);
    assert.deepEqual(reloadAsset(db, first.id).updated_at, first.updated_at);

    // on_conflict = new_version：出 v2，本机没有的附属文件在新版本里也没有
    const next = importSkill(db, as(alice), team.id, local({ content: EDITED, files: undefined, on_conflict: "new_version" }));
    assert.equal(next.status, "updated");
    assert.equal(next.asset.id, first.id);
    assert.equal(next.asset.version, 2);
    assert.notEqual(next.asset.content_hash, first.content_hash);
    const det = getAssetDetail(db, as(alice), first.id);
    assert.equal(det.asset.current_version, 2);
    assert.equal(det.version.content, EDITED);
    assert.equal(det.version.content_hash, next.asset.content_hash);
    assert.equal(det.files, undefined);
    assert.deepEqual(det.asset.source, {
      origin: "import",
      host: "claude-code",
      import_path: "/home/alice/.claude/skills/pr-review",
    });
    const history = getHistory(db, as(alice), first.id);
    assert.deepEqual(
      history.map((v) => [v.version, v.state, v.base_version, v.change_note]),
      [
        [1, "committed", null, ""],
        [2, "committed", 1, "imported from claude-code"],
      ],
    );
    // v1 的文件还在，回看旧版本不受影响
    assert.deepEqual(
      getAssetDetail(db, as(alice), first.id, 1).files?.map((f) => [f.path, f.bytes]),
      [["checklist.md", Buffer.byteLength("- [ ] 测试全绿\n")]],
    );

    // 同一份再来一遍 → unchanged，带不带 on_conflict 都一样
    const again = local({ content: EDITED, files: undefined, on_conflict: "new_version" });
    assert.deepEqual(importSkill(db, as(alice), team.id, again), { status: "unchanged", asset: next.asset });
    assert.equal(rows(db, "asset_version"), 2);
    assert.equal(checkIntegrity(db, sa).ok, true);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("import: the match is the caller's own skill of that name in that team", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, outsider, team, other } = fixture(dir);
    const mine = importSkill(db, as(alice), team.id, local()).asset;

    // 别人的同名 skill 不算匹配：各自新建，互不相干
    const theirs = importSkill(db, as(bob), team.id, local({ content: EDITED }));
    assert.equal(theirs.status, "created");
    assert.notEqual(theirs.asset.id, mine.id);
    assert.equal(getAssetDetail(db, as(bob), theirs.asset.id).asset.owner_user_id, bob.id);

    // 另一个团队里也是新的一条
    const elsewhere = importSkill(db, as(alice), other.id, local());
    assert.equal(elsewhere.status, "created");
    assert.notEqual(elsewhere.asset.id, mine.id);
    assert.equal(reloadAsset(db, elsewhere.asset.id).team_id, other.id);

    assert.deepEqual(importSkill(db, as(alice), team.id, local()), { status: "unchanged", asset: mine });
    assert.equal(rows(db, "asset"), 3);

    // 不是团队成员：看不到团队即 NOT_FOUND
    expectDomain(() => importSkill(db, as(outsider), team.id, local()), "NOT_FOUND");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("import: input is validated before anything is written", () => {
  const dir = tempDir();
  try {
    const { db, alice, team } = fixture(dir);
    const bad: Partial<ImportSkillInput>[] = [
      { name: "PR Review" },
      { name: "other-name" }, // 与 SKILL.md frontmatter 的 name 不一致
      { content: "没有 frontmatter 的正文" },
      { title: "" },
      { host: "" },
      { host: "Claude Code" },
      { import_path: "" },
      { import_path: "x".repeat(1025) },
      { on_conflict: "overwrite" as "new_version" },
      { files: [{ path: "../escape.sh", encoding: "utf8", content: "x" }] },
    ];
    for (const patch of bad) {
      expectDomain(() => importSkill(db, as(alice), team.id, local(patch)), "INVALID_ARGUMENT");
    }
    assert.equal(rows(db, "asset"), 0);

    // 已有同名资产时同样先校验：坏输入不会被当成"内容不同"
    importSkill(db, as(alice), team.id, local());
    for (const patch of bad) {
      expectDomain(() => importSkill(db, as(alice), team.id, local(patch)), "INVALID_ARGUMENT");
    }
    assert.equal(rows(db, "asset_version"), 1);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("import: a new version never slips past the review gate, and an archived skill stays out of search", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, bob, team } = fixture(dir);
    const first = importSkill(db, as(alice), team.id, local()).asset;
    // 共享到团队之后它就不再是 private
    const shared = applyVisibility(db, reloadAsset(db, first.id), planVisibility(db, as(alice), reloadAsset(db, first.id), { visibility: "team" }).plan, alice.id);
    assert.equal(shared.visibility, "team");

    // review_mode = share：管理者改已共享资产是直通 → updated，可见性不动
    const direct = importSkill(db, as(alice), team.id, local({ content: EDITED, on_conflict: "new_version" }));
    assert.equal(direct.status, "updated");
    assert.equal(direct.asset.version, 2);
    assert.equal(direct.asset.visibility, "team");

    // review_mode = all：同样的更新要过审批，import 不代发审批单 → conflict，库不动
    updateTeam(db, sa, team, { review_mode: "all" });
    const gated = local({ content: skillMd("pr-review", "3. 等 CI"), on_conflict: "new_version" });
    assert.deepEqual(importSkill(db, as(alice), team.id, gated), { status: "conflict", asset: direct.asset });
    assert.equal(rows(db, "asset_version"), 2);
    assert.equal(rows(db, "review"), 0);
    // 内容相同仍是 unchanged
    assert.deepEqual(importSkill(db, as(alice), team.id, local({ content: EDITED })), {
      status: "unchanged",
      asset: direct.asset,
    });

    // private 资产不受团队审批模式影响；归档的那条照样能更新，但不回到检索里
    const mine = importSkill(db, as(bob), team.id, local()).asset;
    applyStatus(db, reloadAsset(db, mine.id), "archived");
    const indexed = rows(db, "asset_fts");
    const kept = importSkill(db, as(bob), team.id, local());
    assert.equal(kept.status, "unchanged");
    assert.equal(kept.asset.status, "archived");
    const revived = importSkill(db, as(bob), team.id, local({ content: EDITED, on_conflict: "new_version" }));
    assert.equal(revived.status, "updated");
    assert.equal(revived.asset.version, 2);
    assert.equal(revived.asset.status, "archived");
    assert.equal(rows(db, "asset_fts"), indexed);
    assert.equal(checkIntegrity(db, sa).ok, true);
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
