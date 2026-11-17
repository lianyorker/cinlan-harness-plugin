import type { AuditRecord, Page } from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import { invalid } from "./errors.js";
import { nowIso } from "./ids.js";
import { requireTeamRole, resolveTeam } from "./meta.js";
import { makePage, readPage } from "./paging.js";
import { optIso, optString, Validator } from "./validate.js";

/**
 * 审计（data-model §7）：只追加，无删除接口。
 * `detail` 只放变更前后的元数据（可见性、状态、版本号、绑定），正文与 key 一律不进。
 * 写入与业务变更应在同一个 withTx 里，审计失败即整体回滚，避免"改了却没记录"。
 */

export interface AuditEntry {
  action: string;
  request_id?: string | null;
  actor_user_id?: string | null;
  actor_agent_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  detail?: Record<string, unknown>;
}

/** 命中即视为把不该落库的东西塞进了 detail：直接报错，不静默丢弃。 */
const FORBIDDEN_DETAIL_KEY = /content|body|files|bytes|digest|secret|password|token|authorization|user_key/i;

function assertClean(detail: unknown, path: string): void {
  if (detail === null || typeof detail !== "object") return;
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    const at = `${path}.${key}`;
    if (FORBIDDEN_DETAIL_KEY.test(key)) throw new Error(`audit detail must not carry ${at}`);
    if (Array.isArray(value)) {
      value.forEach((item, i) => assertClean(item, `${at}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      assertClean(value, at);
    }
  }
}

export function writeAudit(db: Db, entry: AuditEntry): void {
  const detail = entry.detail ?? {};
  assertClean(detail, "detail");
  db.prepare(
    `INSERT INTO audit (at, request_id, actor_user_id, actor_agent_id, action, target_type, target_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    entry.request_id ?? null,
    entry.actor_user_id ?? null,
    entry.actor_agent_id ?? null,
    entry.action,
    entry.target_type ?? null,
    entry.target_id ?? null,
    JSON.stringify(detail),
  );
}

interface AuditRow {
  id: number;
  at: string;
  request_id: string | null;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string;
}

function toRecord(row: AuditRow): AuditRecord {
  return { ...row, detail: JSON.parse(row.detail) as Record<string, unknown> };
}

/**
 * TA 的边界：audit 没有 team 列，只能按目标反查——
 * 目标是本团队的 asset / agent / review / team 才算本团队；`user`、`user-key`
 * 与没有目标的系统动作都只对 SA 可见。已 purge 的资产目标行已不在 asset 表，
 * 对应的遗留审计记录因此也对 TA 不可见。
 */
function teamScopeSql(teamParam: string): string {
  return `(
    (target_type = 'team' AND target_id = :${teamParam})
    OR (target_type = 'asset' AND target_id IN (SELECT id FROM asset WHERE team_id = :${teamParam}))
    OR (target_type = 'agent' AND target_id IN (SELECT id FROM agent WHERE team_id = :${teamParam}))
    OR (target_type = 'review' AND target_id IN (SELECT id FROM review WHERE team_id = :${teamParam}))
  )`;
}

/** `audit/list`（P2）：SA 看全部可带团队过滤；TA 必须给团队且只看本团队。 */
export function listAudit(
  db: Db,
  actor: { id: string; is_system_admin: boolean },
  body: Record<string, unknown>,
): Page<AuditRecord> {
  const v = new Validator();
  const action = optString(v, body, "action", 120);
  const actorUserId = optString(v, body, "actor_user_id");
  const actorAgentId = optString(v, body, "actor_agent_id");
  const targetType = optString(v, body, "target_type", 40);
  const targetId = optString(v, body, "target_id");
  const since = optIso(v, body, "since");
  const until = optIso(v, body, "until");
  const page = readPage(v, body);
  const hasTeam = body["team_id"] !== undefined || body["team"] !== undefined;
  v.done();

  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (actor.is_system_admin) {
    if (hasTeam) {
      const team = resolveTeam(db, body);
      where.push(teamScopeSql("tid"));
      params["tid"] = team.id;
    }
  } else {
    if (!hasTeam) throw invalid("invalid argument", ["team_id or team is required"]);
    const team = resolveTeam(db, body);
    requireTeamRole(db, team.id, actor.id, "admin");
    where.push(teamScopeSql("tid"));
    params["tid"] = team.id;
  }
  if (action !== undefined) {
    where.push("action = :action");
    params["action"] = action;
  }
  if (actorUserId !== undefined) {
    where.push("actor_user_id = :actor_user");
    params["actor_user"] = actorUserId;
  }
  if (actorAgentId !== undefined) {
    where.push("actor_agent_id = :actor_agent");
    params["actor_agent"] = actorAgentId;
  }
  if (targetType !== undefined) {
    where.push("target_type = :target_type");
    params["target_type"] = targetType;
  }
  if (targetId !== undefined) {
    where.push("target_id = :target_id");
    params["target_id"] = targetId;
  }
  if (since !== undefined && since !== null) {
    where.push("at >= :since");
    params["since"] = since;
  }
  if (until !== undefined && until !== null) {
    where.push("at <= :until");
    params["until"] = until;
  }
  const sql = `SELECT * FROM audit${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
               ORDER BY id DESC LIMIT :limit OFFSET :offset`;
  const rows = db.prepare(sql).all({ ...params, limit: page.limit + 1, offset: page.offset }) as unknown as AuditRow[];
  return makePage(rows.map(toRecord), page);
}
