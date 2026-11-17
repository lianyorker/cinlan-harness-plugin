import type { Asset, Review } from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import type { Principal } from "./access.js";
import { requireManage } from "./access.js";
import { applyStatus, planVisibility, reloadAsset } from "./asset.js";
import { setVisibilityThroughGate } from "./review.js";
import { optString, Validator } from "./validate.js";
import { invalid } from "./errors.js";

/**
 * 自动沉淀的草稿采纳（O-7，auto-distill.md §3）：
 * draft（仅 owner 可见、不进检索与配装）→ activate（直通——review 门只管 retire 类动作）
 * + 可选共享申请（visibility 提供 → setVisibilityThroughGate，提升按团队策略可能进审批）。
 * 语义全部复用既有状态机与审批门；本文件只把它们组成一个动作。
 */
export function adoptDraft(
  db: Db,
  principal: Principal,
  body: Record<string, unknown>,
): { asset: Asset; review: Review | null } {
  const v = new Validator();
  const assetId = optString(v, body, "asset_id", 64);
  if (assetId === undefined) v.issue("asset_id is required");
  v.done();
  const asset = reloadAsset(db, assetId!);
  requireManage(db, principal, asset);
  if (asset.status !== "draft") throw invalid("asset is not a draft");
  if (asset.visibility !== "private") throw invalid("draft must stay private until adopted");

  // 采纳：草稿转正（activate 恒直通，无需过审）
  const activated = applyStatus(db, asset, "active");

  // 可选：同一动作里申请共享（elevate → 按团队策略开审批；direct → 直接生效）
  const wantsVisibility = body["visibility"] !== undefined && body["visibility"] !== null;
  if (!wantsVisibility) return { asset: activated, review: null };
  const plan = planVisibility(db, principal, activated, body);
  const noteV = new Validator();
  const out = setVisibilityThroughGate(db, principal, activated, plan.plan, plan.elevates, optString(noteV, body, "note", 500) ?? "");
  return { asset: out.result, review: out.review };
}
