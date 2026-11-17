import type {
  Agent,
  Asset,
  AssetVersion,
  InjectionMode,
  LoadoutBinding,
  ResolveItem,
  ResolveResult,
  ResolveSkipped,
  ResolveSkill,
  SkipReason,
} from "@cinlan/knowledge-sdk";
import type { Db } from "./db.js";
import { accessibleParams, ACCESSIBLE_SQL, canRead, NOT_EXPIRED_SQL } from "./access.js";
import type { Principal } from "./access.js";
import { findAssetRow, isExpired, readVersionRow, toAsset } from "./asset.js";
import { alreadyExists, forbidden, invalid, notFound } from "./errors.js";
import { nowIso, sha256Hex } from "./ids.js";
import { getAgent, getTeamById, requireTeamRole, teamRole } from "./meta.js";
import { withTx } from "./tx.js";
import { optInt, optOneOf, reqOneOf, Validator } from "./validate.js";

/**
 * 配装：固定绑定 + ACL（loadout.md §2）。
 * 读权限跟着 Owner 走：resolve 以 Agent 的 Owner 为 principal，并带上该 Agent 自身（agent 可见资产靠绑定授权）；
 * 调用者是谁只影响"能不能操作/解析这个 Agent"。
 */

const INJECTION_MODES: readonly InjectionMode[] = ["inject", "tool"];

export const DEFAULTS = {
  budget_chars: 12000,
  max_items: 30,
  /** 目录行上限（loadout.md §2 步骤 7b）。 */
  catalog_lines: 50,
  /** 目录行里的摘要长度（§2 步骤 6）。 */
  catalog_summary: 80,
};

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------

interface BindingRow {
  agent_id: string;
  asset_id: string;
  priority: number;
  injection_mode: string;
  pin_version: number | null;
  source: string;
  bound_by: string;
  created_at: string;
}

function toBinding(row: BindingRow): LoadoutBinding {
  return {
    asset_id: row.asset_id,
    priority: row.priority,
    injection_mode: row.injection_mode as InjectionMode,
    pin_version: row.pin_version,
    source: row.source as LoadoutBinding["source"],
    bound_by: row.bound_by,
    created_at: row.created_at,
  };
}

function requireAgent(db: Db, actor: Principal, agent_id: unknown): Agent {
  if (typeof agent_id !== "string" || agent_id === "") throw invalid("invalid argument", ["agent_id is required"]);
  const agent = getAgent(db, agent_id);
  // 团队外的人看不到这个 Agent
  if (!agent || teamRole(db, agent.team_id, actor.user.id) === "none") throw notFound("agent not found");
  return agent;
}

/** Agent Owner 或本团队 TA；其余成员 FORBIDDEN。 */
function requireAgentAuthority(db: Db, actor: Principal, agent: Agent): void {
  if (agent.owner_user_id === actor.user.id) return;
  if (teamRole(db, agent.team_id, actor.user.id) === "admin") return;
  throw forbidden("agent owner or team admin required");
}

/** Agent 视角的 principal：Owner 的读权限 + 该 Agent 自身的绑定授权。 */
function agentPrincipal(agent: Agent): Principal {
  return { user: { id: agent.owner_user_id }, agent: { id: agent.id, owner_user_id: agent.owner_user_id } };
}

/**
 * 绑定权（data-model §3）：
 * - Agent Owner：绑"自己可读"的资产；
 * - Team Admin：绑"该 Agent 的 Owner 可读"的资产，以及本团队 `agent` 可见的资产（绑定即授权）。
 * 看不见即 NOT_FOUND（不泄露存在性）。
 */
function requireBindAuthority(db: Db, actor: Principal, agent: Agent, assetId: string): Asset {
  const row = findAssetRow(db, assetId);
  const asset = row ? toAsset(row) : null;
  if (!asset) throw notFound("asset not found");
  if (agent.owner_user_id !== actor.user.id && teamRole(db, agent.team_id, actor.user.id) !== "admin") {
    throw notFound("asset not found");
  }
  if (canRead(db, agentPrincipal(agent), asset)) return asset;
  if (
    agent.owner_user_id !== actor.user.id &&
    teamRole(db, agent.team_id, actor.user.id) === "admin" &&
    asset.visibility === "agent" &&
    asset.team_id === agent.team_id
  ) {
    return asset;
  }
  throw notFound("asset not found");
}

function requireCommittedVersion(db: Db, asset_id: string, pin: number): void {
  const row = readVersionRow(db, asset_id, pin);
  if (!row || row.state !== "committed") {
    throw invalid("invalid argument", [`pin_version ${pin} is not a committed version of this asset`]);
  }
}

export function bindAsset(db: Db, actor: Principal, body: Record<string, unknown>): LoadoutBinding {
  const v = new Validator();
  const agent_id = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  const asset_id = typeof body["asset_id"] === "string" ? body["asset_id"] : "";
  if (agent_id === "") v.issue("agent_id is required");
  if (asset_id === "") v.issue("asset_id is required");
  const priority = optInt(v, body, "priority", 0, 10000);
  const injection_mode = optOneOf(v, body, "injection_mode", INJECTION_MODES);
  const pin_version = body["pin_version"] === null ? null : optInt(v, body, "pin_version", 1);
  v.done();

  const agent = requireAgent(db, actor, agent_id);
  requireAgentAuthority(db, actor, agent);
  requireBindAuthority(db, actor, agent, asset_id);
  if (typeof pin_version === "number") requireCommittedVersion(db, asset_id, pin_version);

  const existing = db
    .prepare("SELECT * FROM agent_asset WHERE agent_id = ? AND asset_id = ?")
    .get(agent_id, asset_id) as BindingRow | undefined;
  // 幂等：已绑定则覆盖参数，保留 created_at（排序稳定）
  const row: BindingRow = {
    agent_id,
    asset_id,
    priority: priority ?? existing?.priority ?? 100,
    injection_mode: injection_mode ?? (existing?.injection_mode as InjectionMode | undefined) ?? "inject",
    pin_version: pin_version === undefined ? (existing?.pin_version ?? null) : pin_version,
    source: existing?.source ?? "manual",
    bound_by: actor.user.id,
    created_at: existing?.created_at ?? nowIso(),
  };
  db.prepare(
    `INSERT OR REPLACE INTO agent_asset (agent_id, asset_id, priority, injection_mode, pin_version, source, bound_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.agent_id,
    row.asset_id,
    row.priority,
    row.injection_mode,
    row.pin_version,
    row.source,
    row.bound_by,
    row.created_at,
  );
  return toBinding(row);
}

export function unbindAsset(db: Db, actor: Principal, body: Record<string, unknown>): void {
  const agent_id = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  const asset_id = typeof body["asset_id"] === "string" ? body["asset_id"] : "";
  if (agent_id === "" || asset_id === "") throw invalid("invalid argument", ["agent_id and asset_id are required"]);
  const agent = requireAgent(db, actor, agent_id);
  requireAgentAuthority(db, actor, agent);
  requireBindAuthority(db, actor, agent, asset_id);
  const res = db.prepare("DELETE FROM agent_asset WHERE agent_id = ? AND asset_id = ?").run(agent_id, asset_id);
  if (res.changes === 0) throw notFound("binding not found");
}

const SYNC_MODES = ["add-missing", "replace"] as const;

/**
 * 团队默认模板下发到已有 Agent（api.md §3.4、sop.md B.5）。
 * TA 专属：api.md 的权限列只有 TA，不放开给 Agent Owner。
 * - add-missing：只补目标上没有的绑定，已有的（手工或旧模板）一律不动；
 * - replace：先删目标上 `source = 'template'` 的行再整份拷贝，
 *   手工绑定的同资产行靠主键冲突保留（INSERT OR IGNORE）。
 */
export function syncTemplate(
  db: Db,
  actor: Principal,
  body: Record<string, unknown>,
): { applied: number; removed: number; template_agent_id: string; bindings: LoadoutBinding[] } {
  const v = new Validator();
  const agent_id = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  if (agent_id === "") v.issue("agent_id is required");
  const mode = reqOneOf(v, body, "mode", SYNC_MODES);
  v.done();

  const agent = requireAgent(db, actor, agent_id);
  requireTeamRole(db, agent.team_id, actor.user.id, "admin");

  const templateId = getTeamById(db, agent.team_id)?.template_agent_id ?? null;
  if (templateId === null) throw invalid("invalid argument", ["team has no default template"]);
  if (templateId === agent.id) throw invalid("invalid argument", ["cannot sync the team template onto itself"]);
  const template = getAgent(db, templateId);
  if (!template || template.status !== "active") throw invalid("invalid argument", ["team template is archived"]);

  const now = nowIso();
  const { applied, removed } = withTx(db, () => {
    let removedCount = 0;
    if (mode === "replace") {
      const res = db
        .prepare("DELETE FROM agent_asset WHERE agent_id = ? AND source = 'template'")
        .run(agent.id);
      removedCount = Number(res.changes);
    }
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO agent_asset (agent_id, asset_id, priority, injection_mode, pin_version, source, bound_by, created_at)
         SELECT ?, t.asset_id, t.priority, t.injection_mode, t.pin_version, 'template', ?, ?
         FROM agent_asset t
         WHERE t.agent_id = ?
           AND NOT EXISTS (SELECT 1 FROM agent_asset x WHERE x.agent_id = ? AND x.asset_id = t.asset_id)`,
      )
      .run(agent.id, actor.user.id, now, templateId, agent.id);
    return { applied: Number(res.changes), removed: removedCount };
  });

  const bindings = (
    db
      .prepare("SELECT * FROM agent_asset WHERE agent_id = ? ORDER BY priority, created_at, asset_id")
      .all(agent.id) as unknown as BindingRow[]
  ).map(toBinding);
  return { applied, removed, template_agent_id: templateId, bindings };
}

/** 整表替换（loadout/set）：未列出的旧绑定删除，列出的 upsert；重复 asset_id 拒绝。 */
export function setBindings(
  db: Db,
  actor: Principal,
  body: Record<string, unknown>,
): (LoadoutBinding & { asset: Asset | null; available: boolean })[] {
  const v = new Validator();
  const agent_id = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  if (agent_id === "") v.issue("agent_id is required");
  const raw = body["bindings"];
  const wanted: { asset_id: string; priority: number; injection_mode: InjectionMode; pin_version: number | null }[] = [];
  if (!Array.isArray(raw)) v.issue("bindings must be an array");
  else
    for (const entry of raw as Record<string, unknown>[]) {
      const asset_id = typeof entry?.["asset_id"] === "string" ? entry["asset_id"] : "";
      if (asset_id === "") {
        v.issue("bindings[].asset_id is required");
        continue;
      }
      const priority = optInt(v, entry ?? {}, "priority", 0, 10000) ?? 100;
      const injection_mode = optOneOf(v, entry ?? {}, "injection_mode", INJECTION_MODES) ?? "inject";
      const pin_version = entry?.["pin_version"] === null ? null : (optInt(v, entry ?? {}, "pin_version", 1) ?? null);
      wanted.push({ asset_id, priority, injection_mode, pin_version });
    }
  if (wanted.length > 200) v.issue("bindings holds at most 200 items");
  v.done();

  const agent = requireAgent(db, actor, agent_id);
  requireAgentAuthority(db, actor, agent);
  return withTx(db, () => {
    const seen = new Set<string>();
    for (const item of wanted) {
      if (seen.has(item.asset_id)) throw alreadyExists(`duplicate asset in bindings: ${item.asset_id}`);
      seen.add(item.asset_id);
      requireBindAuthority(db, actor, agent, item.asset_id);
      if (item.pin_version !== null) requireCommittedVersion(db, item.asset_id, item.pin_version);
    }
    db.prepare("DELETE FROM agent_asset WHERE agent_id = ?").run(agent_id);
    const now = nowIso();
    for (const item of wanted) {
      db.prepare(
        `INSERT INTO agent_asset (agent_id, asset_id, priority, injection_mode, pin_version, source, bound_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
      ).run(agent_id, item.asset_id, item.priority, item.injection_mode, item.pin_version, actor.user.id, now);
    }
    return listBindings(db, actor, agent_id);
  });
}

export function listBindings(
  db: Db,
  actor: Principal,
  agent_id: unknown,
): (LoadoutBinding & { asset: Asset | null; available: boolean })[] {
  const agent = requireAgent(db, actor, agent_id);
  requireAgentAuthority(db, actor, agent);
  const rows = db
    .prepare("SELECT * FROM agent_asset WHERE agent_id = ? ORDER BY priority, created_at, asset_id")
    .all(agent.id) as unknown as BindingRow[];
  const principal = agentPrincipal(agent);
  const now = nowIso();
  return rows.map((row) => {
    const assetRow = findAssetRow(db, row.asset_id);
    const asset = assetRow ? toAsset(assetRow) : null;
    return {
      ...toBinding(row),
      asset,
      available:
        asset !== null && canRead(db, principal, asset) && asset.status === "active" && !isExpired(asset, now),
    };
  });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 框架标签转义：资产正文不能提前闭合外框或伪造段（loadout.md §3）。 */
function escapeTags(text: string): string {
  return text.replace(
    /<(\/?)(cinlan_knowledge[a-z_]*|core|skills|catalog|tools)(\s[^<>]*)?>/gi,
    (_m, slash: string, tag: string, attrs?: string) => `&lt;${slash}${tag}${attrs ?? ""}&gt;`,
  );
}

function countChars(text: string): number {
  return [...text].length;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function catalogLine(asset: Asset): string {
  const summary = asset.summary === "" ? "" : ` —— ${escapeTags(clip(asset.summary, DEFAULTS.catalog_summary))}`;
  return `- ${asset.id}  ${escapeTags(asset.title)}${summary}`;
}

function coreBlock(asset: Asset, version: AssetVersion): string {
  return `## ${escapeTags(asset.title)}  (${asset.id}  v${version.version})\n${escapeTags(version.content)}`;
}

function skillLine(asset: Asset): string {
  const summary = asset.summary === "" ? "" : ` —— ${escapeTags(asset.summary)}`;
  return `- ${String(asset.name)}${summary}`;
}

const TOOLS_LINE =
  "knowledge_search 查团队与个人记忆；knowledge_open 取全文；knowledge_save 记下值得留存的结论（默认仅自己可见）；knowledge_share 申请共享给团队；knowledge_status 自检。会话收尾时把值得留存的候选交给 knowledge_session_report（落草稿收件箱，由人采纳），用户明确说「记下来」才用 knowledge_save。";

/** 与 sha256Hex 的输出等长，只用于预算计量。 */
const DIGEST_PLACEHOLDER = "0".repeat(64);

interface Frame {
  teamName: string;
  agentName: string;
  core: string[];
  skills: string[];
  catalog: string[];
}

function render(frame: Frame, digest: string): string {
  const parts: string[] = [];
  parts.push(`<cinlan_knowledge team="${frame.teamName}" agent="${frame.agentName}" digest="${digest}">`);
  parts.push(
    "以下是团队记忆中枢为本 Agent 配装的内容。<core> 是必须遵守的团队约定；<catalog> 与其他记忆按需用工具取。",
  );
  if (frame.core.length > 0) parts.push(["\n<core>", ...frame.core].join("\n") + "\n</core>");
  if (frame.skills.length > 0) parts.push(["\n<skills>", ...frame.skills].join("\n") + "\n</skills>");
  if (frame.catalog.length > 0) parts.push(["\n<catalog>", ...frame.catalog].join("\n") + "\n</catalog>");
  parts.push(`\n<tools>\n${TOOLS_LINE}\n</tools>`);
  parts.push("</cinlan_knowledge>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface Candidate {
  asset: Asset;
  version: AssetVersion;
  binding: LoadoutBinding;
}

function versionFromRow(row: NonNullable<ReturnType<typeof readVersionRow>>): AssetVersion {
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

export function resolveLoadout(db: Db, actor: Principal, body: Record<string, unknown>): ResolveResult {
  const v = new Validator();
  const agent_id = typeof body["agent_id"] === "string" ? body["agent_id"] : "";
  if (agent_id === "") v.issue("agent_id is required");
  const budget_chars = optInt(v, body, "budget_chars", 1000, 200000) ?? DEFAULTS.budget_chars;
  const max_bytes = optInt(v, body, "max_bytes", 1000, 2000000);
  const max_items = optInt(v, body, "max_items", 1, 200) ?? DEFAULTS.max_items;
  const if_digest =
    typeof body["if_digest"] === "string" && body["if_digest"] !== "" ? body["if_digest"] : undefined;
  v.done();

  const agent = requireAgent(db, actor, agent_id);
  requireAgentAuthority(db, actor, agent);
  const team = db.prepare("SELECT name FROM team WHERE id = ?").get(agent.team_id) as { name: string } | undefined;
  if (!team) throw notFound("team not found");

  const principal = agentPrincipal(agent);
  const now = nowIso();

  const bindings = (
    db.prepare("SELECT * FROM agent_asset WHERE agent_id = ? ORDER BY priority, created_at, asset_id").all(agent.id) as unknown as BindingRow[]
  ).map(toBinding);

  const skipped: ResolveSkipped[] = [];
  const candidates: Candidate[] = [];
  const skillNames = new Set<string>();
  const skills: ResolveSkill[] = [];

  // 步骤 3–5：收窄 → 定版 → 去重。skills[] 在预算之前定稿（§2 末段），不受预算影响。
  for (const binding of bindings) {
    const row = findAssetRow(db, binding.asset_id);
    const asset = row ? toAsset(row) : null;
    let reason: SkipReason | null = null;
    if (!asset || !canRead(db, principal, asset)) reason = "no_access";
    else if (asset.status !== "active") reason = "not_active";
    else if (isExpired(asset, now)) reason = "expired";
    if (reason !== null || !asset) {
      skipped.push({ asset_id: binding.asset_id, reason: reason ?? "no_access" });
      continue;
    }
    const vrow = readVersionRow(db, asset.id, binding.pin_version ?? asset.current_version);
    if (!vrow || vrow.state !== "committed") {
      skipped.push({ asset_id: binding.asset_id, reason: "not_active" });
      continue;
    }
    if (asset.type === "skill" && asset.name !== null) {
      if (skillNames.has(asset.name)) {
        skipped.push({ asset_id: binding.asset_id, reason: "name_conflict" });
        continue;
      }
      skillNames.add(asset.name);
    }
    const version = versionFromRow(vrow);
    candidates.push({ asset, version, binding });
    if (binding.injection_mode === "inject" && asset.type === "skill" && asset.name !== null) {
      skills.push({ asset_id: asset.id, name: asset.name, version: version.version, content_hash: version.content_hash });
    }
  }

  // 步骤 7：预算。外框、说明行、<tools> 的固定开销天然包含在渲染结果里，逐条试放即可。
  const frame: Frame = { teamName: team.name, agentName: agent.name, core: [], skills: [], catalog: [] };
  const items: ResolveItem[] = [];
  let downgraded = 0;
  let injected = 0;

  // 上限管的是最终发出去的文本，头行里的 digest（定长 64 位十六进制）也占预算：用等长占位符量。
  const withinBudget = (): boolean => {
    const text = render(frame, DIGEST_PLACEHOLDER);
    return countChars(text) <= budget_chars && (max_bytes === undefined || bytesOf(text) <= max_bytes);
  };

  /** 整条进或整条不进：放不进就回滚。 */
  const tryPush = (target: string[], line: string): boolean => {
    target.push(line);
    if (withinBudget()) return true;
    target.pop();
    return false;
  };

  const pushCatalog = (cand: Candidate, mode: InjectionMode, isDowngrade: boolean): boolean => {
    if (frame.catalog.length >= DEFAULTS.catalog_lines) return false;
    const line = catalogLine(cand.asset);
    if (!tryPush(frame.catalog, line)) return false;
    items.push({
      asset_id: cand.asset.id,
      type: cand.asset.type,
      title: cand.asset.title,
      version: cand.version.version,
      mode,
      chars: countChars(line),
      downgraded: isDowngrade,
    });
    return true;
  };

  for (const cand of candidates) {
    if (cand.binding.injection_mode !== "inject") continue;
    const isSkill = cand.asset.type === "skill";
    const target = isSkill ? frame.skills : frame.core;
    const line = isSkill ? skillLine(cand.asset) : coreBlock(cand.asset, cand.version);
    if (injected < max_items && tryPush(target, line)) {
      injected++;
      items.push({
        asset_id: cand.asset.id,
        type: cand.asset.type,
        title: cand.asset.title,
        version: cand.version.version,
        mode: "inject",
        chars: countChars(line),
        downgraded: false,
      });
      continue;
    }
    // 放不下或已到 max_items → 降级为目录行
    if (pushCatalog(cand, "inject", true)) {
      downgraded++;
    } else {
      skipped.push({ asset_id: cand.asset.id, reason: "budget" });
    }
  }

  // tool 项：直接进目录
  for (const cand of candidates) {
    if (cand.binding.injection_mode !== "tool") continue;
    if (!pushCatalog(cand, "tool", false)) skipped.push({ asset_id: cand.asset.id, reason: "budget" });
  }

  // 步骤 8–9：digest 由无 digest 的文本算出，再写入头行（头行里的 digest 不参与自身计算）。
  const digest = sha256Hex(render(frame, ""));
  if (if_digest !== undefined && if_digest === digest) {
    // not_modified 只表示文本不用重发（digest 相同即逐字节相同）；items / skills / skipped /
    // downgraded 照常返回当前值——skill 升版本不改文本、digest 不变，物化清单要靠它刷新
    // （acceptance-report §5.4 拍板）。chars / bytes / text 保持 0 / 空表示「无需重投」。
    return {
      not_modified: true,
      digest,
      chars: 0,
      bytes: 0,
      text: "",
      items,
      skills,
      skipped,
      downgraded,
      generated_at: now,
    };
  }
  const text = render(frame, digest);
  return {
    not_modified: false,
    digest,
    chars: countChars(text),
    bytes: bytesOf(text),
    text,
    items,
    skills,
    skipped,
    downgraded,
    generated_at: now,
  };
}

// ---------------------------------------------------------------------------
// 检索侧共用（search.ts 复用同一份收窄条件，含过期）
// ---------------------------------------------------------------------------

/** 可读 + active + 未过期的资产集合；别名固定为 `a`，参数见 resolveFilterParams。 */
export const RESOLVE_WHERE_SQL = `${ACCESSIBLE_SQL} AND a.status = 'active' AND ${NOT_EXPIRED_SQL}`;

export function resolveFilterParams(principal: Principal, now = nowIso()): Record<string, string | null> {
  return { ...accessibleParams(principal), now };
}
