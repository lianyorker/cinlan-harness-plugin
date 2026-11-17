import type {
  Asset,
  AssetStatus,
  AssetVersion,
  Page,
  Review,
  ReviewKind,
  ReviewMode,
  ReviewStatus,
  Visibility,
} from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import { canManage, requireManage, requireRead } from "./access.js";
import type { Principal } from "./access.js";
import {
  applyStatus,
  applyVisibility,
  appendVersion,
  checkTransition,
  commitVersion,
  prepareUpdate,
  proposeUpdate,
  readVersionRow,
  reloadAsset,
  updateAsset as updateAssetDirect,
  type StatusAction,
  type UpdateAssetInput,
  type UpdateResult,
  type VisibilityPlan,
  type WriteVersionInput,
} from "./asset.js";
import { forbidden, invalid, notFound, reasonRequired, reviewNotPending, versionConflict } from "./errors.js";
import { newId, nowIso } from "./ids.js";
import { getTeamById, requireTeamRole, resolveTeam, teamRole } from "./meta.js";
import { makePage, readPage } from "./paging.js";
import { withTx } from "./tx.js";
import { optBool, optOneOf, optString, Validator } from "./validate.js";

/**
 * 审批层（data-model §6）。
 * 策略判定与裁决都只在这里实现一次：动作层（update / set-visibility / set-status）经由
 * `*ThroughGate` 进入，直通就当场生效，需审批就落一条 review 等 TA 裁决。
 */

// ---------------------------------------------------------------------------
// 策略矩阵
// ---------------------------------------------------------------------------

export type PolicyDecision = "direct" | "review" | "forbidden";

/** 修改：private 恒直通；非 private 管理者看模式，只读者在 off 下禁止、其余进审批（提议）。 */
export function updatePolicy(mode: ReviewMode, isPrivate: boolean, manager: boolean): PolicyDecision {
  if (isPrivate) return "direct";
  if (manager) return mode === "all" ? "review" : "direct";
  return mode === "off" ? "forbidden" : "review";
}

/** 提升可见性（private → team / restricted / agent）：share 与 all 都进审批；降低永远直通。 */
export function visibilityPolicy(mode: ReviewMode, elevates: boolean): PolicyDecision {
  if (!elevates) return "direct";
  return mode === "off" ? "direct" : "review";
}

/** 弃用 / 归档非 private 资产：仅 all 进审批。activate / restore 与 private 资产恒直通。 */
export function retirePolicy(mode: ReviewMode, isPrivate: boolean): PolicyDecision {
  if (isPrivate) return "direct";
  return mode === "all" ? "review" : "direct";
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

interface ReviewRow {
  id: string;
  team_id: string;
  asset_id: string;
  kind: string;
  payload: string;
  status: string;
  requester_user_id: string;
  note: string;
  reviewer_user_id: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    team_id: row.team_id,
    asset_id: row.asset_id,
    kind: row.kind as ReviewKind,
    status: row.status as ReviewStatus,
    requester_user_id: row.requester_user_id,
    note: row.note,
    reviewer_user_id: row.reviewer_user_id,
    reason: row.reason,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

type UpdateMeta = Omit<WriteVersionInput, "content" | "files">;

type Payload =
  | { kind: "update"; base_version: number; version: number; meta: UpdateMeta }
  | { kind: "share"; plan: VisibilityPlan }
  | { kind: "retire"; status: AssetStatus };

function readReview(db: Db, id: string): ReviewRow | null {
  const row = db.prepare("SELECT * FROM review WHERE id = ?").get(id) as unknown as ReviewRow | undefined;
  return row ?? null;
}

function mustReview(db: Db, id: unknown): ReviewRow {
  if (typeof id !== "string" || id === "") throw invalid("invalid argument", ["review_id is required"]);
  const row = readReview(db, id);
  if (!row) throw notFound("review not found");
  return row;
}

function parsePayload(row: ReviewRow): Payload {
  return JSON.parse(row.payload) as Payload;
}

/** 同一资产同类 pending 只保留最新一条，旧的置 withdrawn（data-model §6）。 */
function openReview(
  db: Db,
  asset: Asset,
  kind: ReviewKind,
  requester: string,
  note: string,
  payload: Payload,
): Review {
  const now = nowIso();
  db.prepare("UPDATE review SET status = 'withdrawn', decided_at = ? WHERE asset_id = ? AND kind = ? AND status = 'pending'").run(
    now,
    asset.id,
    kind,
  );
  const id = newId("rev");
  db.prepare(
    `INSERT INTO review (id, team_id, asset_id, kind, payload, status, requester_user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, asset.team_id, asset.id, kind, JSON.stringify(payload), requester, note, now);
  return toReview(mustReview(db, id));
}

/** 条件更新：只有仍为 pending 才能被抢占；影响行数为 0 = 已被裁决或 stale。 */
function claim(db: Db, id: string, status: ReviewStatus, reviewer: string, reason: string | null): void {
  const res = db
    .prepare(
      "UPDATE review SET status = ?, reviewer_user_id = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(status, reviewer, reason, nowIso(), id);
  if (res.changes === 0) throw reviewNotPending();
}

// ---------------------------------------------------------------------------
// 裁决
// ---------------------------------------------------------------------------

const DECISIONS = ["approve", "reject"] as const;

function decideOne(
  db: Db,
  actor: Principal,
  review_id: unknown,
  decision: "approve" | "reject",
  reason: string | null,
): Review {
  const row = mustReview(db, typeof review_id === "string" ? review_id : "");
  const asset = reloadAsset(db, row.asset_id);
  // 审批人 = 资产所属团队的 Admin；非本团队 → NOT_FOUND
  requireTeamRole(db, asset.team_id, actor.user.id, "admin");
  if (row.requester_user_id === actor.user.id) {
    const team = getTeamById(db, asset.team_id);
    if (!team?.allow_self_approve) throw forbidden("self approval is disabled");
  }

  return withTx(db, () => {
    const current = reloadAsset(db, row.asset_id);
    // approve 的 update 若 base_version 已落后 → stale，资产不动，申请人重提
    let status: ReviewStatus = decision === "reject" ? "rejected" : "approved";
    const payload = parsePayload(row);
    if (decision === "approve" && payload.kind === "update" && payload.base_version !== current.current_version) {
      status = "stale";
    }
    claim(db, row.id, status, actor.user.id, reason);
    if (status === "stale") return toReview(mustReview(db, row.id));

    if (decision === "reject") {
      if (payload.kind === "update") {
        db.prepare("UPDATE asset_version SET state = 'rejected' WHERE asset_id = ? AND version = ? AND state = 'proposed'").run(
          current.id,
          payload.version,
        );
      }
      return toReview(mustReview(db, row.id));
    }

    switch (payload.kind) {
      case "update":
        commitVersion(db, current, payload.version, payload.meta);
        break;
      case "share":
        applyVisibility(db, current, payload.plan, actor.user.id);
        break;
      case "retire":
        applyStatus(db, current, payload.status);
        break;
    }
    return toReview(mustReview(db, row.id));
  });
}

export function decideReview(db: Db, actor: Principal, body: Record<string, unknown>): Review {
  const v = new Validator();
  const review_id = optString(v, body, "review_id");
  const decision = optOneOf(v, body, "decision", DECISIONS);
  const rawReason = optString(v, body, "reason", 500);
  if (review_id === undefined) v.issue("review_id is required");
  if (decision === undefined) v.issue("decision is required");
  // 驳回必带 reason：在参数层先拦，避免先查库再报错暴露 review 是否存在
  if (decision === "reject" && (rawReason === undefined || rawReason.trim() === "")) throw reasonRequired();
  v.done();
  return decideOne(db, actor, review_id, decision!, rawReason ?? null);
}

export function withdrawReview(db: Db, actor: Principal, review_id: unknown): Review {
  const row = mustReview(db, review_id);
  const asset = reloadAsset(db, row.asset_id);
  if (row.requester_user_id !== actor.user.id) {
    // 看得见（TA）但不许替别人撤回；看不见的人一律 NOT_FOUND
    if (teamRole(db, asset.team_id, actor.user.id) === "admin") throw forbidden("only the requester can withdraw");
    throw notFound("review not found");
  }
  return withTx(db, () => {
    claim(db, row.id, "withdrawn", actor.user.id, null);
    const payload = parsePayload(row);
    if (payload.kind === "update") {
      db.prepare("UPDATE asset_version SET state = 'rejected' WHERE asset_id = ? AND version = ? AND state = 'proposed'").run(
        asset.id,
        payload.version,
      );
    }
    return toReview(mustReview(db, row.id));
  });
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export interface ReviewDetail extends Review {
  /** kind = update 时：当前已提交版本与提议版本的原文，供 diff。 */
  current: AssetVersion | null;
  proposed: AssetVersion | null;
}

function versionOut(db: Db, asset_id: string, version: number): AssetVersion | null {
  const row = readVersionRow(db, asset_id, version);
  if (!row) return null;
  return {
    asset_id: row.asset_id,
    version: row.version,
    state: row.state as AssetVersion["state"],
    base_version: row.base_version,
    title: row.title,
    summary: row.summary,
    content: row.content,
    content_hash: row.content_hash,
    author_user_id: row.author_user_id,
    change_note: row.change_note,
    created_at: row.created_at,
  };
}

export function getReview(db: Db, actor: Principal, review_id: unknown): ReviewDetail {
  const row = mustReview(db, typeof review_id === "string" ? review_id : "");
  const asset = reloadAsset(db, row.asset_id);
  const isRequester = row.requester_user_id === actor.user.id;
  if (!isRequester && teamRole(db, asset.team_id, actor.user.id) !== "admin") throw notFound("review not found");
  const payload = parsePayload(row);
  return {
    ...toReview(row),
    current: versionOut(db, asset.id, asset.current_version),
    proposed: payload.kind === "update" ? versionOut(db, asset.id, payload.version) : null,
  };
}

const REVIEW_STATUSES = ["pending", "approved", "rejected", "withdrawn", "stale"] as const;

export function listReviews(db: Db, actor: Principal, body: Record<string, unknown>): Page<Review> {
  const v = new Validator();
  const mine = optBool(v, body, "mine") ?? false;
  const status = optOneOf(v, body, "status", REVIEW_STATUSES);
  const asset_id = optString(v, body, "asset_id");
  const page = readPage(v, body);
  const hasTeam = body["team_id"] !== undefined || body["team"] !== undefined;
  const team = hasTeam ? resolveTeam(db, body) : null;
  v.done();

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (mine) {
    where.push("requester_user_id = ?");
    params.push(actor.user.id);
  } else {
    if (!team) throw invalid("invalid argument", ["team_id or team is required (or mine: true)"]);
    requireTeamRole(db, team.id, actor.user.id, "admin");
  }
  if (team) {
    where.push("team_id = ?");
    params.push(team.id);
  }
  if (status !== undefined) {
    where.push("status = ?");
    params.push(status);
  }
  if (asset_id !== undefined) {
    where.push("asset_id = ?");
    params.push(asset_id);
  }
  const rows = db
    .prepare(`SELECT * FROM review WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, page.limit + 1, page.offset) as unknown as ReviewRow[];
  return makePage(rows.map(toReview), page);
}

// ---------------------------------------------------------------------------
// 门面：动作层经此进入
// ---------------------------------------------------------------------------

export interface GateOutcome<T> {
  /** true = 已生效；false = 落成待审批，资产未变。 */
  applied: boolean;
  result: T;
  review: Review | null;
}

/** 申请人自己是 TA 且团队允许自批 → 当场生效，仍留一条 approved 的 review（审批人 = 本人）。 */
function maybeSelfApprove(db: Db, actor: Principal, team_id: string, review: Review): { review: Review; applied: boolean } {
  const team = getTeamById(db, team_id);
  if (team?.allow_self_approve && teamRole(db, team_id, actor.user.id) === "admin") {
    return { review: decideOne(db, actor, review.id, "approve", null), applied: true };
  }
  return { review, applied: false };
}

export function updateThroughGate(
  db: Db,
  actor: Principal,
  asset: Asset,
  input: UpdateAssetInput,
  /** 回滚等场景强制产生新版本（即使内容相同也要留痕） */
  force?: boolean,
): GateOutcome<UpdateResult> {
  const current = reloadAsset(db, asset.id);
  requireRead(db, actor, current);
  const team = getTeamById(db, current.team_id);
  if (!team) throw notFound("team not found");
  const policy = updatePolicy(team.review_mode, current.visibility === "private", canManage(db, actor, current));
  if (policy === "forbidden") throw forbidden("review_mode off: read-only members cannot edit shared assets");
  if (policy === "direct") {
    // 直通沿用版本层的实现（含 base_version 冲突与"无变化"判定）；force 时跳过无变化短路
    if (force === true) {
      const result = withTx(db, () => {
        const currentRow = readVersionRow(db, current.id, current.current_version);
        if (!currentRow) throw notFound("current version row not found");
        // 回滚带现行版本的文件（不清空 skill 附属文件）
        const files = db
          .prepare("SELECT path, bytes, sha256, data FROM asset_file WHERE asset_id = ? AND version = ? ORDER BY path")
          .all(current.id, current.current_version) as unknown as { path: string; bytes: number; sha256: string; data: Uint8Array }[];
        const filesInput = files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, data: Buffer.from(f.data) }));
        const { version } = appendVersion(db, current, "committed", input.base_version, actor.user.id, {
          title: input.title ?? current.title,
          summary: input.summary ?? current.summary,
          content: input.content ?? currentRow.content,
          tags: current.tags,
          layer: current.layer,
          expires_at: current.expires_at,
          files: filesInput,
        }, input.change_note ?? "");
        commitVersion(db, current, version.version, {
          title: input.title ?? current.title,
          summary: input.summary ?? current.summary,
          tags: current.tags,
          layer: current.layer,
          expires_at: current.expires_at,
        });
        return { changed: true, version: version.version };
      });
      return { applied: true, result, review: null };
    }
    const result = updateAssetDirect(db, actor, current, input);
    return { applied: true, result, review: null };
  }

  // 需审批：先做与直通一致的校验与变更判定，再落 proposed 版本行 + review(update)
  if (input.base_version !== current.current_version) throw versionConflict(current.current_version);
  const { changed } = prepareUpdate(db, current, input);
  if (!changed) return { applied: true, result: { changed: false, version: current.current_version }, review: null };
  const opened = withTx(db, () => {
    // 版本行与审批单同一事务：createReview 失败时不能留一条没人管的 proposed 版本
    const proposed = proposeUpdate(db, actor, current, input);
    const review = openReview(db, current, "update", actor.user.id, input.change_note ?? "", {
      kind: "update",
      base_version: input.base_version,
      version: proposed.version,
      meta: {
        title: proposed.next.title,
        summary: proposed.next.summary,
        tags: proposed.next.tags,
        layer: proposed.next.layer,
        expires_at: proposed.next.expires_at,
      },
    });
    return { proposed, review };
  });
  const decided = maybeSelfApprove(db, actor, current.team_id, opened.review);
  return {
    applied: decided.applied,
    result: { changed: true, version: opened.proposed.version },
    review: decided.review,
  };
}

export function setVisibilityThroughGate(
  db: Db,
  actor: Principal,
  asset: Asset,
  plan: VisibilityPlan,
  elevates: boolean,
  note = "",
): GateOutcome<Asset> {
  const current = reloadAsset(db, asset.id);
  requireManage(db, actor, current);
  const team = getTeamById(db, current.team_id);
  if (!team) throw notFound("team not found");
  if (visibilityPolicy(team.review_mode, elevates) === "direct") {
    return { applied: true, result: applyVisibility(db, current, plan, actor.user.id), review: null };
  }
  const opened = withTx(db, () => openReview(db, current, "share", actor.user.id, note, { kind: "share", plan }));
  const decided = maybeSelfApprove(db, actor, current.team_id, opened);
  // 自批已生效 → 返回落库后的快照；待审批 → 资产确实没变
  return { applied: decided.applied, result: decided.applied ? reloadAsset(db, current.id) : current, review: decided.review };
}
export function setStatusThroughGate(
  db: Db,
  actor: Principal,
  asset: Asset,
  action: StatusAction,
  note = "",
): GateOutcome<Asset> {
  const current = reloadAsset(db, asset.id);
  requireManage(db, actor, current);
  const to = checkTransition(current, action);
  const team = getTeamById(db, current.team_id);
  if (!team) throw notFound("team not found");
  const retires = action === "deprecate" || action === "archive";
  if (!retires || retirePolicy(team.review_mode, current.visibility === "private") === "direct") {
    return { applied: true, result: applyStatus(db, current, to), review: null };
  }
  const opened = withTx(db, () => openReview(db, current, "retire", actor.user.id, note, { kind: "retire", status: to }));
  const decided = maybeSelfApprove(db, actor, current.team_id, opened);
  return { applied: decided.applied, result: decided.applied ? reloadAsset(db, current.id) : current, review: decided.review };
}

