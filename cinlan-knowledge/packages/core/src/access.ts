import type { AclPermission, Asset } from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import { forbidden, notFound } from "./errors.js";
import { teamRole } from "./meta.js";

/**
 * 可见性与权限判定只在这里实现一次（data-model §3）。
 * principal = { user, agent? }；agent 必属于该 user。
 * 对外语义：看不见即 NOT_FOUND，看得见但角色不够才 FORBIDDEN。
 */

export interface Principal {
  user: { id: string };
  agent?: { id: string; owner_user_id: string };
}

/** acl 命中且 permission 至少为所需级别。 */
export function aclHit(
  db: Db,
  asset: Asset,
  subject_type: "user" | "role" | "agent",
  subject_id: string,
  permission: AclPermission,
): boolean {
  const row = db
    .prepare("SELECT permission FROM acl WHERE asset_id = ? AND subject_type = ? AND subject_id = ?")
    .get(asset.id, subject_type, subject_id) as { permission: AclPermission } | undefined;
  if (!row) return false;
  if (permission === "read") return row.permission === "read" || row.permission === "manage";
  return row.permission === "manage";
}

export function aclHitAny(
  db: Db,
  asset: Asset,
  principal: Principal,
  permission: AclPermission,
): boolean {
  const role = teamRole(db, asset.team_id, principal.user.id);
  if (aclHit(db, asset, "user", principal.user.id, permission)) return true;
  if (role !== "none" && aclHit(db, asset, "role", role, permission)) return true;
  if (principal.agent && aclHit(db, asset, "agent", principal.agent.id, permission)) return true;
  return false;
}

function agentBound(db: Db, agent_id: string, asset_id: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM agent_asset WHERE agent_id = ? AND asset_id = ?").get(agent_id, asset_id) !==
    undefined
  );
}

export function canManage(db: Db, principal: Principal, asset: Asset): boolean {
  if (asset.owner_user_id === principal.user.id) return true;
  if (asset.visibility !== "private" && teamRole(db, asset.team_id, principal.user.id) === "admin") return true;
  return aclHitAny(db, asset, principal, "manage");
}

export function canRead(db: Db, principal: Principal, asset: Asset): boolean {
  if (asset.owner_user_id === principal.user.id) return true;
  if (asset.status === "draft") return false;
  if (asset.status === "archived") return canManage(db, principal, asset);
  // canManage ⇒ canRead（data-model §3；O-14②）：审批人要读得到自己管的资产。
  // 放在 draft / archived 之后：draft 仍仅 Owner，archived 仍仅 canManage。
  if (canManage(db, principal, asset)) return true;
  if (asset.visibility === "team") {
    return teamRole(db, asset.team_id, principal.user.id) !== "none";
  }
  if (asset.visibility === "restricted") return aclHitAny(db, asset, principal, "read");
  if (asset.visibility === "agent") {
    return principal.agent !== undefined && agentBound(db, principal.agent.id, asset.id);
  }
  return false;
}

/** 读权限经由哪条规则：owner > acl > role > admin（acl/check 的 via）。 */
export function readVia(
  db: Db,
  principal: Principal,
  asset: Asset,
): "owner" | "acl" | "role" | "admin" | null {
  if (!canRead(db, principal, asset)) return null;
  if (asset.owner_user_id === principal.user.id) return "owner";
  if (aclHitAny(db, asset, principal, "read")) return "acl";
  if (asset.visibility === "team") return "role";
  return "admin";
}

export function manageVia(
  db: Db,
  principal: Principal,
  asset: Asset,
): "owner" | "acl" | "role" | "admin" | null {
  if (!canManage(db, principal, asset)) return null;
  if (asset.owner_user_id === principal.user.id) return "owner";
  if (aclHitAny(db, asset, principal, "manage")) return "acl";
  if (asset.visibility !== "private" && teamRole(db, asset.team_id, principal.user.id) === "admin") return "admin";
  return null;
}

export function requireRead(db: Db, principal: Principal, asset: Asset | null): Asset {
  if (!asset || !canRead(db, principal, asset)) throw notFound("asset not found");
  return asset;
}

export function requireManage(db: Db, principal: Principal, asset: Asset | null): Asset {
  requireRead(db, principal, asset);
  if (!canManage(db, principal, asset!)) throw forbidden("manage permission required");
  return asset!;
}

/**
 * 列表 / 检索用的同一份谓词（与 canRead 逐条对应；改一处必须改另一处，T1 同时覆盖两边）。
 * 参数顺序固定：user_id, asset.team_id 关联、role、user acl、agent acl、绑定。
 * 过期（expires_at 早于 now）在运行期等同 deprecated，由调用方传入 now 并追加到状态条件。
 */
export const ACCESSIBLE_SQL = `(
  a.owner_user_id = :uid
  OR (a.status != 'draft' AND a.status != 'archived' AND (
        (a.visibility != 'private' AND EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = a.team_id AND m.user_id = :uid AND m.role = 'admin'))
        OR EXISTS (SELECT 1 FROM acl c WHERE c.asset_id = a.id AND c.permission = 'manage'
                   AND ((c.subject_type = 'user' AND c.subject_id = :uid)
                     OR (c.subject_type = 'role' AND c.subject_id = (SELECT m.role FROM team_member m WHERE m.team_id = a.team_id AND m.user_id = :uid))
                     OR (c.subject_type = 'agent' AND :aid IS NOT NULL AND c.subject_id = :aid)))))
  OR (a.status != 'draft' AND a.status != 'archived' AND a.visibility = 'team'
      AND EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = a.team_id AND m.user_id = :uid))
  OR (a.status != 'draft' AND a.status != 'archived' AND a.visibility = 'restricted'
      AND (EXISTS (SELECT 1 FROM acl c WHERE c.asset_id = a.id AND c.subject_type = 'user' AND c.subject_id = :uid)
        OR EXISTS (SELECT 1 FROM acl c WHERE c.asset_id = a.id AND c.subject_type = 'role'
                   AND c.subject_id = (SELECT m.role FROM team_member m WHERE m.team_id = a.team_id AND m.user_id = :uid))
        OR (:aid IS NOT NULL AND EXISTS (SELECT 1 FROM acl c WHERE c.asset_id = a.id AND c.subject_type = 'agent' AND c.subject_id = :aid))))
  OR (a.status != 'draft' AND a.status != 'archived' AND a.visibility = 'agent'
      AND :aid IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_asset b WHERE b.agent_id = :aid AND b.asset_id = a.id))
  OR (a.status = 'archived' AND (
        (a.visibility != 'private' AND EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = a.team_id AND m.user_id = :uid AND m.role = 'admin'))
        OR EXISTS (SELECT 1 FROM acl c WHERE c.asset_id = a.id AND c.permission = 'manage'
                   AND ((c.subject_type = 'user' AND c.subject_id = :uid)
                     OR (c.subject_type = 'role' AND c.subject_id = (SELECT m.role FROM team_member m WHERE m.team_id = a.team_id AND m.user_id = :uid))
                     OR (c.subject_type = 'agent' AND :aid IS NOT NULL AND c.subject_id = :aid)))))
)`;

/** 可读集合参数；SQL 里一律用命名参数，避免位置错位。 */
export function accessibleParams(principal: Principal): Record<string, string | null> {
  return { uid: principal.user.id, aid: principal.agent?.id ?? null };
}

/**
 * 过期过滤：检索与配装共用同一个条件（data-model §4「检索与配装不各写一份」）。
 * 过期只影响"能否被检索/注入"，不影响"能否被读到"——Owner 仍可用 asset/get 看到并续期。
 * 调用方需提供 `:now` 参数；别名固定为 `a`。
 */
export const NOT_EXPIRED_SQL = `(a.expires_at IS NULL OR a.expires_at > :now)`

export function accessibleFilterParams(principal: Principal, now: string): Record<string, string | null> {
  return { ...accessibleParams(principal), now };
}
