import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createTeam, createUser, updateTeam, type User } from "../src/meta.js";
import { DomainError } from "../src/errors.js";
import {
  applyVisibility,
  createAsset,
  getAssetDetail,
  planVisibility,
} from "../src/asset.js";
import {
  decideReview,
  getReview,
  listReviews,
  retirePolicy,
  setStatusThroughGate,
  setVisibilityThroughGate,
  updatePolicy,
  updateThroughGate,
  visibilityPolicy,
  withdrawReview,
} from "../src/review.js";
import type { Principal } from "../src/access.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ck-review-"));
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

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  sa: User;
  alice: User;
  bob: User;
  carol: User;
  team: ReturnType<typeof createTeam>;
}

function fixture(dir: string, mode: "off" | "share" | "all", selfApprove = true): Fixture {
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
  const alice = createUser(db, { name: "alice", display_name: "Alice" });
  const bob = createUser(db, { name: "bob", display_name: "Bob" });
  const carol = createUser(db, { name: "carol", display_name: "Carol" });
  const team = createTeam(db, sa, { name: "demo", title: "Demo" });
  addMember(db, sa, team, alice, "admin");
  addMember(db, sa, team, bob);
  addMember(db, sa, team, carol);
  updateTeam(db, alice, team, { review_mode: mode, allow_self_approve: selfApprove });
  return { db, sa, alice, bob, carol, team: { ...team, review_mode: mode, allow_self_approve: selfApprove } };
}

function as(user: User): Principal {
  return { user: { id: user.id } };
}

/** 把 alice 的资产直接共享到 team（绕过门槛，只用于布置场景）。 */
function share(db: Fixture["db"], owner: User, asset: ReturnType<typeof createAsset>["asset"]) {
  const plan = planVisibility(db, as(owner), asset, { visibility: "team" });
  return applyVisibility(db, asset, plan.plan, owner.id);
}

const MODES = ["off", "share", "all"] as const;
type Mode = (typeof MODES)[number];
type Want = "direct" | "review" | "forbidden";
type Action = "create" | "update-private" | "elevate" | "update-shared" | "retire" | "lower";

/** data-model §6 的表，逐行照抄。caller：manager = 管理者（新建 / 改 private 即 Owner），reader = 仅可读者。 */
const SECTION6: { action: Action; caller: "manager" | "reader"; want: Record<Mode, Want> }[] = [
  { action: "create", caller: "manager", want: { off: "direct", share: "direct", all: "direct" } },
  { action: "update-private", caller: "manager", want: { off: "direct", share: "direct", all: "direct" } },
  { action: "elevate", caller: "manager", want: { off: "direct", share: "review", all: "review" } },
  { action: "update-shared", caller: "manager", want: { off: "direct", share: "direct", all: "review" } },
  { action: "update-shared", caller: "reader", want: { off: "forbidden", share: "review", all: "review" } },
  { action: "retire", caller: "manager", want: { off: "direct", share: "direct", all: "review" } },
  { action: "lower", caller: "manager", want: { off: "direct", share: "direct", all: "direct" } },
];

/** 一行里要各跑一遍的变体：提升的三个目标、弃用与归档。 */
const VARIANTS: Record<Action, readonly string[]> = {
  create: ["memory"],
  "update-private": ["content"],
  elevate: ["team", "restricted", "agent"],
  "update-shared": ["content"],
  retire: ["deprecate", "archive"],
  lower: ["private"],
};

function wantOf(action: Action, caller: "manager" | "reader"): Record<Mode, Want> {
  return SECTION6.find((r) => r.action === action && r.caller === caller)!.want;
}

test("T2: policy functions — data-model §6 的表全枚举", () => {
  for (const mode of MODES) {
    // private 只有 Owner 够得着：恒直通，与模式、调用者无关
    for (const manager of [true, false]) assert.equal(updatePolicy(mode, true, manager), "direct", `update private / ${mode}`);
    assert.equal(updatePolicy(mode, false, true), wantOf("update-shared", "manager")[mode], `update manager / ${mode}`);
    assert.equal(updatePolicy(mode, false, false), wantOf("update-shared", "reader")[mode], `update reader / ${mode}`);
    assert.equal(visibilityPolicy(mode, true), wantOf("elevate", "manager")[mode], `elevate / ${mode}`);
    assert.equal(visibilityPolicy(mode, false), wantOf("lower", "manager")[mode], `lower / ${mode}`);
    assert.equal(retirePolicy(mode, false), wantOf("retire", "manager")[mode], `retire / ${mode}`);
    assert.equal(retirePolicy(mode, true), "direct", `retire private / ${mode}`);
  }
});

test("T2: gates — 每一格经动作门实跑，需审批的格子分自批与非自批", () => {
  const dirs: string[] = [];
  let cells = 0;
  try {
    for (const mode of MODES) {
      for (const selfApprove of [true, false]) {
        const dir = tempDir();
        dirs.push(dir);
        const { db, alice, bob, carol, team } = fixture(dir, mode, selfApprove);
        // 第二名 TA：自批关闭时裁决 alice 的申请
        const dave = createUser(db, { name: "dave", display_name: "Dave" });
        addMember(db, alice, team, dave, "admin");
        const reviewsOf = (id: string): number =>
          (db.prepare("SELECT COUNT(*) AS n FROM review WHERE asset_id = ?").get(id) as { n: number }).n;

        for (const row of SECTION6) {
          const want = row.want[mode];
          // 管理者分两种：TA（alice，可能自批）与普通成员 Owner（bob，永远要等 TA）；仅可读者是 carol
          for (const actor of row.caller === "reader" ? [carol] : [alice, bob]) {
            const owner = row.caller === "reader" ? alice : actor;
            for (const variant of VARIANTS[row.action]) {
              const where = `${mode} / self=${selfApprove} / ${row.action}:${variant} / ${actor.name}`;
              cells++;
              const { asset } = createAsset(db, as(owner), team.id, { type: "memory", title: where, content: "v1" });
              const live = () => getAssetDetail(db, as(owner), asset.id).asset;

              if (row.action === "create") {
                assert.equal(want, "direct", where);
                assert.equal(asset.visibility, "private", where);
                assert.equal(asset.status, "active", where);
                assert.equal(reviewsOf(asset.id), 0, where);
                continue;
              }

              let run: () => {
                applied: boolean;
                review: { id: string; status: string; reviewer_user_id: string | null; note: string } | null;
              };
              let landed: () => boolean;
              switch (row.action) {
                case "update-private":
                  run = () => updateThroughGate(db, as(actor), asset, { base_version: 1, content: "v2" });
                  landed = () => live().current_version === 2;
                  break;
                case "update-shared":
                  share(db, owner, asset);
                  run = () => updateThroughGate(db, as(actor), asset, { base_version: 1, content: "v2" });
                  landed = () => live().current_version === 2;
                  break;
                case "elevate": {
                  const body =
                    variant === "restricted"
                      ? { visibility: variant, acl: [{ subject_type: "user", subject_id: carol.id, permission: "read" }] }
                      : { visibility: variant };
                  const plan = planVisibility(db, as(actor), asset, body);
                  assert.equal(plan.elevates, true, where);
                  run = () => setVisibilityThroughGate(db, as(actor), asset, plan.plan, plan.elevates, `note: ${where}`);
                  landed = () => live().visibility === variant;
                  break;
                }
                case "lower": {
                  const shared = share(db, owner, asset);
                  const plan = planVisibility(db, as(actor), shared, { visibility: "private" });
                  assert.equal(plan.elevates, false, where);
                  run = () => setVisibilityThroughGate(db, as(actor), shared, plan.plan, plan.elevates);
                  landed = () => live().visibility === "private";
                  break;
                }
                case "retire": {
                  const shared = share(db, owner, asset);
                  run = () => setStatusThroughGate(db, as(actor), shared, variant as "deprecate" | "archive", `note: ${where}`);
                  landed = () => live().status === (variant === "deprecate" ? "deprecated" : "archived");
                  break;
                }
              }

              if (want === "forbidden") {
                expectDomain(run, "FORBIDDEN");
                assert.equal(reviewsOf(asset.id), 0, where);
                assert.equal(landed(), false, where);
                continue;
              }
              const out = run();
              if (want === "direct") {
                assert.equal(out.applied, true, where);
                assert.equal(out.review, null, `直通不留审批单: ${where}`);
                assert.equal(reviewsOf(asset.id), 0, where);
                assert.equal(landed(), true, where);
                continue;
              }
              // 需审批
              assert.equal(reviewsOf(asset.id), 1, where);
              // 提升 / 退休把 approve 时的 note 带进审批单；改版本走 change_note（这一格是空的）
              const wantNote = row.action === "elevate" || row.action === "retire" ? `note: ${where}` : "";
              if (selfApprove && actor.id === alice.id) {
                // 申请人是 TA 且允许自批：当场生效，留一条 approved（审批人 = 本人）
                assert.equal(out.applied, true, where);
                assert.equal(out.review!.status, "approved", where);
                assert.equal(out.review!.reviewer_user_id, actor.id, where);
                assert.equal(out.review!.note, wantNote, `审批单留下申请说明: ${where}`);
                assert.equal(landed(), true, where);
                continue;
              }
              // 非自批：落 pending，资产不动，等 TA 裁决
              assert.equal(out.applied, false, where);
              assert.equal(out.review!.status, "pending", where);
              assert.equal(out.review!.reviewer_user_id, null, where);
              assert.equal(out.review!.note, wantNote, `审批单留下申请说明: ${where}`);
              assert.equal(landed(), false, `待审批期间资产不变: ${where}`);
              // 申请人自己裁决不了：TA 被自批开关拦住；普通成员不是审批人
              expectDomain(() => decideReview(db, as(actor), { review_id: out.review!.id, decision: "approve" }), "FORBIDDEN");
              assert.equal(landed(), false, where);
              const approver = actor.id === alice.id ? dave : alice;
              const decided = decideReview(db, as(approver), { review_id: out.review!.id, decision: "approve" });
              assert.equal(decided.status, "approved", where);
              assert.equal(decided.reviewer_user_id, approver.id, where);
              assert.equal(landed(), true, `TA 批准后生效: ${where}`);
            }
          }
        }
        closeDatabase(db);
      }
    }
    // 每个 (模式, 自批) 组合 19 格：新建 2 + 改 private 2 + 提升 2×3 + 管理者改 2 + 只读者改 1 + 弃用/归档 2×2 + 降低 2
    assert.equal(cells, MODES.length * 2 * 19);
  } finally {
    for (const d of dirs) cleanup(d);
  }
});

test("review: share gate — share mode pending, self-approve applies at once", () => {
  const dir = tempDir();
  try {
    const { db, sa, alice, bob, team } = fixture(dir, "share", false);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });
    const plan = planVisibility(db, as(alice), asset, { visibility: "team" });

    const out = setVisibilityThroughGate(db, as(alice), asset, plan.plan, plan.elevates);
    assert.equal(out.applied, false);
    assert.equal(out.review!.status, "pending");
    assert.equal(out.result.visibility, "private", "待审批期间资产不变");
    expectDomain(() => getAssetDetail(db, as(bob), asset.id), "NOT_FOUND");

    // 申请人不能裁决自己的单（allow_self_approve = false）；非 TA 也不能
    const dave = createUser(db, { name: "dave", display_name: "Dave" });
    addMember(db, alice, team, dave, "admin");
    expectDomain(() => decideReview(db, as(alice), { review_id: out.review!.id, decision: "approve" }), "FORBIDDEN");
    expectDomain(() => decideReview(db, as(bob), { review_id: out.review!.id, decision: "approve" }), "FORBIDDEN");
    // 团队外看不到
    const carolTeam = createTeam(db, sa, { name: "other", title: "Other" });
    addMember(db, sa, carolTeam, bob);
    const outsider = createUser(db, { name: "out", display_name: "Out" });
    expectDomain(() => decideReview(db, as(outsider), { review_id: out.review!.id, decision: "approve" }), "NOT_FOUND");

    // 驳回必须带 reason（参数层先拦）
    expectDomain(() => decideReview(db, as(dave), { review_id: out.review!.id, decision: "reject" }), "REASON_REQUIRED");
    expectDomain(
      () => decideReview(db, as(dave), { review_id: out.review!.id, decision: "reject", reason: "  " }),
      "REASON_REQUIRED",
    );

    const decided = decideReview(db, as(dave), { review_id: out.review!.id, decision: "approve" });
    assert.equal(decided.status, "approved");
    assert.equal(decided.reviewer_user_id, dave.id);
    assert.equal(getAssetDetail(db, as(bob), asset.id).asset.visibility, "team");
    // 二次裁决：已非 pending
    expectDomain(() => decideReview(db, as(dave), { review_id: out.review!.id, decision: "approve" }), "REVIEW_NOT_PENDING");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("review: self-approve still leaves an approved review and applies", () => {
  const dir = tempDir();
  try {
    const { db, alice, team } = fixture(dir, "share", true);
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "c" });
    const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
    const out = setVisibilityThroughGate(db, as(alice), asset, plan.plan, plan.elevates);
    assert.equal(out.applied, true);
    assert.equal(out.review!.status, "approved");
    assert.equal(out.review!.reviewer_user_id, alice.id, "审批人 = 本人，审计可查");
    assert.equal(out.result.visibility, "team");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("review: read-only proposal, stale on approve, withdraw closes it", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, team } = fixture(dir, "share");
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "v1" });
    share(db, alice, asset);

    // 只读者修改非 private：提议
    const prop = updateThroughGate(db, as(bob), asset, { base_version: 1, content: "bob-v2" });
    assert.equal(prop.applied, false);
    assert.equal(prop.review!.kind, "update");
    assert.equal(prop.result.version, 2);
    assert.equal(getAssetDetail(db, as(alice), asset.id).asset.current_version, 1);

    // review/get 带两份原文；申请人与 TA 能看，其他成员不行
    const detail = getReview(db, as(alice), prop.review!.id);
    assert.equal(detail.current!.content, "v1");
    assert.equal(detail.proposed!.content, "bob-v2");
    assert.equal(getReview(db, as(bob), prop.review!.id).proposed!.content, "bob-v2");
    const carolUser = createUser(db, { name: "dave", display_name: "Dave" });
    addMember(db, alice, team, carolUser);
    expectDomain(() => getReview(db, as(carolUser), prop.review!.id), "NOT_FOUND");

    // owner 期间又直接改了一版（v3）→ 审批时 base_version 落后 → stale，资产不动
    updateThroughGate(db, as(alice), asset, { base_version: 1, content: "alice-v2" });
    const stale = decideReview(db, as(alice), { review_id: prop.review!.id, decision: "approve" });
    assert.equal(stale.status, "stale");
    const live = getAssetDetail(db, as(alice), asset.id);
    assert.equal(live.asset.current_version, 3);
    assert.equal(live.version.content, "alice-v2", "stale 不提交提议版本");
    assert.equal(getAssetDetail(db, as(alice), asset.id, 2).version.state, "proposed", "v2 保持 proposed，编号保留");
    expectDomain(
      () => decideReview(db, as(alice), { review_id: prop.review!.id, decision: "approve" }),
      "REVIEW_NOT_PENDING",
    );

    // 重新提议 → 驳回 → 撤回各自关闭单据
    const p2 = updateThroughGate(db, as(bob), asset, { base_version: 3, content: "bob-v3" });
    assert.equal(p2.result.version, 4);
    const rejected = decideReview(db, as(alice), { review_id: p2.review!.id, decision: "reject", reason: "脱敏后再提" });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "脱敏后再提");
    // 驳回后版本编号保留：再提是 v5
    const p3 = updateThroughGate(db, as(bob), asset, { base_version: 3, content: "bob-v4" });
    assert.equal(p3.result.version, 5);
    // 只有申请人能撤回
    expectDomain(() => withdrawReview(db, as(alice), p3.review!.id), "FORBIDDEN");
    assert.equal(withdrawReview(db, as(bob), p3.review!.id).status, "withdrawn");
    expectDomain(() => decideReview(db, as(alice), { review_id: p3.review!.id, decision: "approve" }), "REVIEW_NOT_PENDING");

    // 同类 pending 只留最新一条
    const p4 = updateThroughGate(db, as(bob), asset, { base_version: 3, content: "bob-v5" });
    const p5 = updateThroughGate(db, as(bob), asset, { base_version: 3, content: "bob-v6" });
    assert.equal(getReview(db, as(alice), p4.review!.id).status, "withdrawn");
    assert.equal(getReview(db, as(alice), p5.review!.id).status, "pending");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});

test("review: off forbids reader edits; all gates manager edits and retire", () => {
  const dirs: string[] = [];
  try {
    {
      const d = tempDir();
      dirs.push(d);
      const { db, alice, bob, team } = fixture(d, "off");
      const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "v1" });
      share(db, alice, asset);
      expectDomain(() => updateThroughGate(db, as(bob), asset, { base_version: 1, content: "x" }), "FORBIDDEN");
      closeDatabase(db);
    }
    {
      const d = tempDir();
      dirs.push(d);
      const { db, alice, team } = fixture(d, "all", false);
      // 自批关闭时，管理者的申请要由另一名 TA 裁决
      const dave = createUser(db, { name: "dave", display_name: "Dave" });
      addMember(db, alice, team, dave, "admin");
      const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "v1" });
      share(db, alice, asset);
      // all：管理者改非 private 也要审批
      const up = updateThroughGate(db, as(alice), asset, { base_version: 1, content: "v2" });
      assert.equal(up.applied, false);
      expectDomain(() => decideReview(db, as(alice), { review_id: up.review!.id, decision: "approve" }), "FORBIDDEN");
      assert.equal(getAssetDetail(db, as(alice), asset.id).asset.current_version, 1);
      decideReview(db, as(dave), { review_id: up.review!.id, decision: "approve" });
      assert.equal(getAssetDetail(db, as(alice), asset.id).asset.current_version, 2);
      // all：弃用非 private 也要审批
      const dep = setStatusThroughGate(db, as(alice), asset, "deprecate");
      assert.equal(dep.applied, false);
      assert.equal(dep.result.status, "active");
      decideReview(db, as(dave), { review_id: dep.review!.id, decision: "approve" });
      assert.equal(getAssetDetail(db, as(alice), asset.id).asset.status, "deprecated");
      // private 资产不受审
      const priv = createAsset(db, as(alice), team.id, { type: "memory", title: "P", content: "c" });
      assert.equal(updateThroughGate(db, as(alice), priv.asset, { base_version: 1, content: "c2" }).applied, true);
      closeDatabase(db);
    }
  } finally {
    for (const d of dirs) cleanup(d);
  }
});

test("review: list — mine across teams, TA per team, others refused", () => {
  const dir = tempDir();
  try {
    const { db, alice, bob, carol, team } = fixture(dir, "share");
    const { asset } = createAsset(db, as(alice), team.id, { type: "memory", title: "M", content: "v1" });
    share(db, alice, asset);
    const p = updateThroughGate(db, as(bob), asset, { base_version: 1, content: "bob-v2" });

    const mine = listReviews(db, as(bob), { mine: true });
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0]!.id, p.review!.id);
    // TA 按团队看
    assert.equal(listReviews(db, as(alice), { team_id: team.id }).items.length, 1);
    assert.equal(listReviews(db, as(alice), { team_id: team.id, status: "pending" }).items.length, 1);
    assert.equal(listReviews(db, as(alice), { team_id: team.id, status: "approved" }).items.length, 0);
    // 普通成员看团队列表 → FORBIDDEN
    expectDomain(() => listReviews(db, as(carol), { team_id: team.id }), "FORBIDDEN");
    // 缺团队且非 mine → 400
    expectDomain(() => listReviews(db, as(alice), {}), "INVALID_ARGUMENT");
    closeDatabase(db);
  } finally {
    cleanup(dir);
  }
});
