import type { ActionName } from "@cinlan/knowledge-sdk";

/**
 * 动作注册表：名字即契约。P1 的所有名字先登记，
 * 未实现的处理函数在启动时被排除 —— 注册表里没有的名字一律 UNKNOWN_ACTION。
 */
export const P1_ACTIONS = [
  "auth/verify",
  "user/create",
  "user/create-with-key",
  "user/get",
  "user/list",
  "user/disable",
  "user-key/create",
  "user-key/list",
  "user-key/revoke",
  "team/create",
  "team/get",
  "team/list",
  "team/update",
  "team/delete",
  "team-member/add",
  "team-member/remove",
  "team-member/set-role",
  "team-member/list",
  "agent/ensure",
  "agent/create",
  "agent/get",
  "agent/update",
  "agent/archive",
  "agent/list",
  "agent/set-default-template",
  "agent/get-default-template",
  "asset/create",
  "asset/get",
  "asset/update",
  "asset/list",
  "asset/search",
  "asset/history",
  "asset/set-visibility",
  "asset/set-status",
  "asset/purge",
  "acl/grant",
  "acl/revoke",
  "acl/list",
  "acl/check",
  "loadout/get",
  "loadout/set",
  "loadout/bind",
  "loadout/unbind",
  "loadout/resolve",
  "review/list",
  "review/get",
  "review/decide",
  "review/withdraw",
  "usage/report",
  // P2（sop.md A.3）：后端补件 —— 名字随 sdk 契约逐个登记
  "usage/summary",
  "audit/list",
  "loadout/sync-template",
  "system/stats",
  "system/integrity",
  "system/backup",
  "asset/import",
  // P3（2026-11-16）：O-9 向量检索（通道 A 外置 worker）+ O-7 自动沉淀（通道 A' 客户端抽取）
  "embedding/put",
  "embedding/pending",
  "session/report",
  "inbox/adopt",
  "asset/rollback",
] as const satisfies readonly ActionName[];

const P1_SET: ReadonlySet<string> = new Set(P1_ACTIONS);

export function isKnownAction(action: string): action is ActionName {
  return P1_SET.has(action);
}
