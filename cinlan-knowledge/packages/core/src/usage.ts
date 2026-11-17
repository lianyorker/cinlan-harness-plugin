import type { Agent, UsageGroupBy, UsageKind, UsageSummary } from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import type { Principal } from "./access.js";
import { getAsset } from "./asset.js";
import { forbidden, invalid, isDomainError, notFound as _notFound } from "./errors.js";
import { nowIso } from "./ids.js";
import { getAgent, requireTeamRole, resolveTeam, teamRole } from "./meta.js";
import { withTx } from "./tx.js";
import { optInt, optOneOf, Validator } from "./validate.js";

/**
 * 用量（data-model §7）。
 * 两种事件：`injected`（A1 由 ck 送达后上报 / A0 由 hub 在 /mcp initialize 记）与
 * `opened`（带 x-ck-agent-id 的 asset/get 由 hub 记）。
 * 按 UTC 天聚合进 usage_daily，同时累加 asset.usage_count / last_used_at，保留 180 天。
 *
 * 上报是记账，不是授权：看不到的资产静默跳过，不因一条脏数据让整批失败，也不回传资产是否存在。
 */

const KINDS: readonly UsageKind[] = ["injected", "opened"];
const MAX_EVENTS = 200;
const RETENTION_DAYS = 180;

interface UsageEvent {
  asset_id: string;
  version: number;
  kind: UsageKind;
}

/** UTC 日期，与 usage_daily.day 的口径一致。 */
function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function agentPrincipal(agent: Agent): Principal {
  return { user: { id: agent.owner_user_id }, agent: { id: agent.id, owner_user_id: agent.owner_user_id } };
}

function parseEvents(v: Validator, body: Record<string, unknown>): UsageEvent[] {
  const raw = body["events"];
  if (!Array.isArray(raw)) {
    v.issue("events must be an array");
    return [];
  }
  if (raw.length === 0) {
    v.issue("events must not be empty");
    return [];
  }
  if (raw.length > MAX_EVENTS) {
    v.issue(`events exceeds ${MAX_EVENTS}`);
    return [];
  }
  const out: UsageEvent[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      v.issue(`events[${i}] must be an object`);
      return;
    }
    const e = item as Record<string, unknown>;
    const asset_id = typeof e["asset_id"] === "string" ? e["asset_id"] : "";
    if (asset_id === "") v.issue(`events[${i}].asset_id is required`);
    const version = e["version"];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      v.issue(`events[${i}].version must be a positive integer`);
    }
    const kind = e["kind"];
    if (!KINDS.includes(kind as UsageKind)) v.issue(`events[${i}].kind must be ${KINDS.join(" | ")}`);
    if (asset_id !== "" && typeof version === "number" && KINDS.includes(kind as UsageKind)) {
      out.push({ asset_id, version, kind: kind as UsageKind });
    }
  });
  return out;
}

function upsertDaily(db: Db, day: string, asset_id: string, agent_id: string, kind: UsageKind): void {
  db.prepare(
    `INSERT INTO usage_daily (day, asset_id, agent_id, injected, opened)
     VALUES (:day, :asset_id, :agent_id, :injected, :opened)
     ON CONFLICT(day, asset_id, agent_id) DO UPDATE SET
       injected = injected + excluded.injected,
       opened   = opened   + excluded.opened`,
  ).run({
    day,
    asset_id,
    agent_id,
    injected: kind === "injected" ? 1 : 0,
    opened: kind === "opened" ? 1 : 0,
  });
}

/**
 * 写入一批事件并累加资产计数。返回实际记录的条数（不可读 / 不存在的资产静默跳过）。
 * 已解析出 agent 的调用方直接用这个；HTTP 入口走 reportUsage。
 */
export function recordUsage(db: Db, agent: Agent, events: UsageEvent[]): number {
  if (events.length === 0) return 0;
  const principal = agentPrincipal(agent);
  const day = utcDay();
  const now = nowIso();
  return withTx(db, () => {
    const counts = new Map<string, number>();
    for (const ev of events) {
      if (!readable(db, principal, ev.asset_id)) continue;
      upsertDaily(db, day, ev.asset_id, agent.id, ev.kind);
      counts.set(ev.asset_id, (counts.get(ev.asset_id) ?? 0) + 1);
    }
    for (const [asset_id, n] of counts) {
      db.prepare("UPDATE asset SET usage_count = usage_count + ?, last_used_at = ? WHERE id = ?").run(n, now, asset_id);
    }
    let recorded = 0;
    for (const n of counts.values()) recorded += n;
    return recorded;
  });
}

/** 看不见 / 不存在一律视为不可记账；这里用 getAsset 的 NOT_FOUND 作为判据。 */
function readable(db: Db, principal: Principal, asset_id: string): boolean {
  try {
    getAsset(db, principal, asset_id);
    return true;
  } catch (err) {
    if (isDomainError(err) && err.code === "NOT_FOUND") return false;
    throw err;
  }
}

/** 保留 180 天：按 UTC 天切片直接比较字符串。 */
export function pruneUsage(db: Db, days = RETENTION_DAYS): number {
  const cutoff = utcDay(new Date(Date.now() - days * 86_400_000));
  const res = db.prepare("DELETE FROM usage_daily WHERE day < ?").run(cutoff);
  return Number(res.changes);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** `usage/report`（P1）：Agent Owner 或本团队 TA 才能替它上报。 */
export function reportUsage(db: Db, actor: Principal, body: Record<string, unknown>): { recorded: number } {
  const v = new Validator();
  const agent_id = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  if (agent_id === "") v.issue("agent_id is required");
  const events = parseEvents(v, body);
  v.done();

  const agent = getAgent(db, agent_id);
  if (!agent) throw _notFound("agent not found");
  // Owner 或本团队 TA；团队外一律 NOT_FOUND（不在错误里暴露 Agent 是否存在）
  if (agent.owner_user_id !== actor.user.id) {
    const role = teamRole(db, agent.team_id, actor.user.id);
    if (role === "none") throw _notFound("agent not found");
    if (role !== "admin") throw forbidden("agent owner or team admin required");
  }

  const recorded = recordUsage(db, agent, events);
  pruneUsage(db);
  return { recorded };
}

/**
 * `opened` 记账钩子：hub 处理带 `x-ck-agent-id` 的 asset/get 时调用。
 * 记账失败不能影响读取，因此未知 agent 直接返回 false，不抛错。
 */
export function recordOpened(db: Db, agent_id: string, asset_id: string): boolean {
  const agent = getAgent(db, agent_id);
  if (!agent) return false;
  return recordUsage(db, agent, [{ asset_id, version: 1, kind: "opened" }]) === 1;
}

/** 供 hub 显式校验用：无法解析的 agent_id 与非法参数都按 INVALID_ARGUMENT 处理。 */
export function assertUsageAgent(db: Db, agent_id: unknown): Agent {
  if (typeof agent_id !== "string" || agent_id === "") throw invalid("invalid argument", ["agent_id is required"]);
  const agent = getAgent(db, agent_id);
  if (!agent) throw _notFound("agent not found");
  return agent;
}

// ---------------------------------------------------------------------------
// 汇总（P2）
// ---------------------------------------------------------------------------

const GROUPS: readonly UsageGroupBy[] = ["asset", "agent", "cold"];
const SUMMARY_DAYS_DEFAULT = 90;
/** 与保留期一致：超出 180 天的数据本来就不在库里，窗口再宽没有意义。 */
const SUMMARY_DAYS_MAX = RETENTION_DAYS;

/**
 * `usage/summary`（P2）：TA 看本团队，SA 看全部；`team_id` / `team` 必须给。
 * 窗口是 UTC 天闭区间 [今天-days, 今天]，按 usage_daily.day 字符串比较。
 * 行只输出窗口内有用量的资产 / Agent；`cold` 反过来列窗口内零用量的团队资产。
 * private 资产对 TA 不可见（data-model §3），因此不进 TA 的 by_asset / cold；
 * 资产的状态与标题取当前值，不回溯历史版本。
 */
export function usageSummary(
  db: Db,
  actor: { id: string; is_system_admin: boolean },
  body: Record<string, unknown>,
): UsageSummary {
  const v = new Validator();
  const days = optInt(v, body, "days", 1, SUMMARY_DAYS_MAX) ?? SUMMARY_DAYS_DEFAULT;
  const group_by = optOneOf(v, body, "group_by", GROUPS) ?? null;
  const hasTeam = body["team_id"] !== undefined || body["team"] !== undefined;
  if (!hasTeam) v.issue("team_id or team is required");
  v.done();

  const team = resolveTeam(db, body);
  if (!actor.is_system_admin) requireTeamRole(db, team.id, actor.id, "admin");

  const to = utcDay();
  const from = utcDay(new Date(Date.now() - days * 86_400_000));
  // SA 看全部资产的元数据（data-model §3 的治理兜底）；TA 只看得到非 private 或自己的
  const scope = actor.is_system_admin
    ? { sql: "a.team_id = :tid", params: { tid: team.id } }
    : {
        sql: "a.team_id = :tid AND (a.visibility != 'private' OR a.owner_user_id = :uid)",
        params: { tid: team.id, uid: actor.id },
      };

  const out: UsageSummary = { days, from, to, by_asset: [], by_agent: [], cold: [], agents_stale: [] };
  if (group_by === null || group_by === "asset") out.by_asset = byAsset(db, scope.sql, scope.params, from, to);
  if (group_by === null || group_by === "agent") out.by_agent = byAgent(db, team.id, from, to);
  if (group_by === null || group_by === "cold") out.cold = coldAssets(db, scope.sql, scope.params, from, to);
  if (group_by === null || group_by === "agent") out.agents_stale = agentsStale(db, team.id, from, to);
  return out;
}

interface ScopeParams {
  tid: string;
  uid?: string;
}

function byAsset(
  db: Db,
  scope: string,
  params: ScopeParams,
  from: string,
  to: string,
): UsageSummary["by_asset"] {
  return db
    .prepare(
      `SELECT a.id AS asset_id, a.title, a.type, a.status, a.owner_user_id,
              SUM(u.injected) AS injected, SUM(u.opened) AS opened
         FROM usage_daily u JOIN asset a ON a.id = u.asset_id
        WHERE u.day >= :from AND u.day <= :to AND ${scope}
        GROUP BY a.id
        ORDER BY (SUM(u.injected) + SUM(u.opened)) DESC, a.id`,
    )
    .all({ ...params, from, to }) as unknown as UsageSummary["by_asset"];
}

function byAgent(db: Db, team_id: string, from: string, to: string): UsageSummary["by_agent"] {
  return db
    .prepare(
      `SELECT g.id AS agent_id, g.name, g.host, g.owner_user_id,
              SUM(u.injected) AS injected, SUM(u.opened) AS opened
         FROM usage_daily u JOIN agent g ON g.id = u.agent_id
        WHERE u.day >= :from AND u.day <= :to AND g.team_id = :tid
        GROUP BY g.id
        ORDER BY (SUM(u.injected) + SUM(u.opened)) DESC, g.id`,
    )
    .all({ tid: team_id, from, to }) as unknown as UsageSummary["by_agent"];
}

function coldAssets(
  db: Db,
  scope: string,
  params: ScopeParams,
  from: string,
  to: string,
): UsageSummary["cold"] {
  return db
    .prepare(
      `SELECT a.id AS asset_id, a.title, a.type, a.status, a.owner_user_id, a.visibility, a.updated_at
         FROM asset a
        WHERE ${scope}
          AND a.status IN ('active', 'deprecated')
          AND NOT EXISTS (SELECT 1 FROM usage_daily u
                           WHERE u.asset_id = a.id AND u.day >= :from AND u.day <= :to)
        ORDER BY a.updated_at, a.id`,
    )
    .all({ ...params, from, to }) as unknown as UsageSummary["cold"];
}

/** 窗口内零用量的活跃 Agent（治理：该退役的 Agent 要归档） */
function agentsStale(db: Db, team_id: string, from: string, to: string): UsageSummary["agents_stale"] {
  return db
    .prepare(
      `SELECT g.id AS agent_id, g.name, g.host, g.owner_user_id, g.last_seen_at
         FROM agent g
        WHERE g.team_id = :tid AND g.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM usage_daily u
                           WHERE u.agent_id = g.id AND u.day >= :from AND u.day <= :to)
        ORDER BY g.last_seen_at, g.id`,
    )
    .all({ tid: team_id, from, to }) as unknown as UsageSummary["agents_stale"];
}
