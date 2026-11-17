export type Id = string;
/** 所有 id 形如 <前缀>_<24hex>；id 永不取自标题或文件名 */
export type Slug = string;

export type UserStatus = "active" | "disabled";
export type TeamRole = "admin" | "member";
export type AgentStatus = "active" | "archived";
export type AssetType = "memory" | "skill" | "wiki" | "codegraph";
export type AssetStatus = "draft" | "active" | "deprecated" | "archived";
export type Visibility = "private" | "team" | "restricted" | "agent";
export type MemoryLayer = "core" | "profile" | "atom";
export type InjectionMode = "inject" | "tool";
export type ReviewMode = "off" | "share" | "all";
export type ReviewKind = "share" | "update" | "retire";
export type ReviewStatus = "pending" | "approved" | "rejected" | "withdrawn" | "stale";
export type AclSubjectType = "user" | "role" | "agent";
export type AclPermission = "read" | "manage";
export type UsageKind = "injected" | "opened";
export type AssetOrigin = "tool" | "panel" | "import" | "capture";

export interface User {
  id: Id;
  name: Slug;
  display_name: string;
  is_system_admin: boolean;
  status: UserStatus;
  created_at: string;
}

export interface UserKeyInfo {
  id: Id;
  name: string;
  prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface Team {
  id: Id;
  name: Slug;
  title: string;
  description: string;
  review_mode: ReviewMode;
  allow_self_approve: boolean;
  template_agent_id: Id | null;
  created_at: string;
}

export interface TeamMember {
  user_id: Id;
  user_name: Slug;
  display_name: string;
  role: TeamRole;
  joined_at: string;
}

export interface Agent {
  id: Id;
  team_id: Id;
  owner_user_id: Id;
  name: Slug;
  /** 宿主 slug；只用于统计，每次 agent/ensure 覆盖 */
  host: string;
  description: string;
  is_template: boolean;
  status: AgentStatus;
  last_seen_at: string | null;
  created_at: string;
}

export interface SkillFile {
  path: string;
  encoding: "utf8" | "base64";
  content: string;
}

export interface AssetSource {
  origin: AssetOrigin;
  host?: string;
  agent_id?: Id;
  session_id?: string;
  import_path?: string;
  /** v2 evidence trail（deep-memory.md §2）：同一事实从多个会话报上来时，累积的 session 列表。 */
  session_ids?: string[];
  /** v2 evidence trail：同一事实被多个会话独立报上来的次数（信念强度）。 */
  proof_count?: number;
}

export interface Asset {
  id: Id;
  team_id: Id;
  type: AssetType;
  name: Slug | null;
  title: string;
  summary: string;
  layer: MemoryLayer | null;
  tags: string[];
  owner_user_id: Id;
  visibility: Visibility;
  status: AssetStatus;
  current_version: number;
  expires_at: string | null;
  usage_count: number;
  last_used_at: string | null;
  source: AssetSource;
  created_at: string;
  updated_at: string;
}

export interface AssetVersion {
  asset_id: Id;
  version: number;
  state: "committed" | "proposed" | "rejected";
  base_version: number | null;
  title: string;
  summary: string;
  content: string;
  content_hash: string;
  author_user_id: Id;
  change_note: string;
  created_at: string;
}

export interface AclEntry {
  asset_id: Id;
  subject_type: AclSubjectType;
  subject_id: Id | TeamRole;
  permission: AclPermission;
  granted_by: Id;
  created_at: string;
}

export interface LoadoutBinding {
  asset_id: Id;
  priority: number;
  injection_mode: InjectionMode;
  pin_version: number | null;
  source: "manual" | "template";
  bound_by: Id;
  created_at: string;
}

export interface Review {
  id: Id;
  team_id: Id;
  asset_id: Id;
  kind: ReviewKind;
  status: ReviewStatus;
  requester_user_id: Id;
  note: string;
  reviewer_user_id: Id | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

/** audit/list 的一行（data-model §4）：只读元数据，detail 不含正文与密钥。 */
export interface AuditRecord {
  /** 自增序号，越大越新 */
  id: number;
  at: string;
  request_id: string | null;
  actor_user_id: Id | null;
  actor_agent_id: Id | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
}

export interface AssetHit {
  asset_id: Id;
  type: AssetType;
  title: string;
  summary: string;
  snippet: string;
  score: number;
  version: number;
  visibility: Visibility;
  owner: { id: Id; name: Slug };
  team_id: Id;
  deprecated: boolean;
  updated_at: string;
}

export interface ResolveItem {
  asset_id: Id;
  type: AssetType;
  title: string;
  version: number;
  mode: InjectionMode;
  chars: number;
  downgraded: boolean;
}

export interface ResolveSkill {
  asset_id: Id;
  name: Slug;
  version: number;
  content_hash: string;
}

export type SkipReason = "no_access" | "not_active" | "expired" | "name_conflict" | "budget";

export interface ResolveSkipped {
  asset_id: Id;
  reason: SkipReason;
}

export interface ResolveResult {
  not_modified: boolean;
  digest: string;
  chars: number;
  bytes: number;
  text: string;
  items: ResolveItem[];
  skills: ResolveSkill[];
  skipped: ResolveSkipped[];
  downgraded: number;
  generated_at: string;
}

/** usage/summary 的三种分组（api.md §3.5）。 */
export type UsageGroupBy = "asset" | "agent" | "cold";

export interface UsageByAsset {
  asset_id: Id;
  title: string;
  type: AssetType;
  status: AssetStatus;
  owner_user_id: Id;
  injected: number;
  opened: number;
}

export interface UsageByAgentEntry {
  agent_id: Id;
  name: Slug;
  host: string;
  owner_user_id: Id;
  injected: number;
  opened: number;
}

/** 窗口内零用量的活跃 Agent（治理：该退役的 Agent 要归档） */
export interface UsageStaleAgent {
  agent_id: Id;
  name: string;
  host: string;
  owner_user_id: Id;
  last_seen_at: string;
}

/** 窗口内零用量的团队资产（SOP B.6 的治理入口）。 */
export interface UsageColdAsset {
  asset_id: Id;
  title: string;
  type: AssetType;
  status: AssetStatus;
  owner_user_id: Id;
  visibility: Visibility;
  updated_at: string;
}

export interface UsageSummary {
  days: number;
  /** UTC 日期 YYYY-MM-DD；窗口闭区间 [from, to] */
  from: string;
  to: string;
  by_asset: UsageByAsset[];
  by_agent: UsageByAgentEntry[];
  cold: UsageColdAsset[];
  /** P5（optimization-analysis §1.7）：窗口内零用量的活跃 Agent（治理：该退役的 Agent 要归档） */
  agents_stale: UsageStaleAgent[];
}

export type ImportStatus = "created" | "unchanged" | "updated" | "conflict";

/** asset/import 回的资产摘要；`unchanged` / `conflict` 时就是没被动过的那条现有资产。 */
export interface ImportedAsset {
  id: Id;
  name: Slug;
  title: string;
  /** 现行版本号 */
  version: number;
  /** 现行版本的 content_hash */
  content_hash: string;
  visibility: Visibility;
  status: AssetStatus;
  updated_at: string;
}

/** system/stats：库存统计只在这里出，`/healthz` 不带（blueprint §3）。 */
export interface SystemStats {
  generated_at: string;
  /** 已执行到的迁移号 */
  schema_version: number;
  /** 库的逻辑大小 = page_count × page_size，不含 WAL */
  db_bytes: number;
  users: { total: number; active: number; disabled: number };
  teams: number;
  agents: { total: number; active: number; archived: number; templates: number };
  assets: {
    total: number;
    by_type: Record<AssetType, number>;
    by_status: Record<AssetStatus, number>;
    /** 已过期（expires_at 早于当前时间，检索与配装等同不可读） */
    expired: number;
    /** 7 天内将过期（治理提示：需要续期或归档） */
    expiring_7d: number;
  };
  versions: number;
  files: { total: number; bytes: number };
  reviews: { total: number; pending: number };
  usage_rows: number;
  audit_rows: number;
}

export type IntegrityIssueKind =
  /** 现行版本的 content_hash 与复算值不一致 */
  | "hash_mismatch"
  /** 附属文件的 sha256 / bytes 与库里的数据不一致 */
  | "file_mismatch"
  /** asset.current_version 指向不存在或未提交的版本行 */
  | "dangling_version"
  /** 非 archived 资产没有检索行 */
  | "fts_missing"
  /** 检索行与现行版本的标题 / 标签 / 摘要 / 正文不一致 */
  | "fts_stale"
  /** 检索行没有对应资产，或 archived 资产仍在索引里 */
  | "fts_orphan"
  /** PRAGMA integrity_check / foreign_key_check 的原始报告 */
  | "sqlite";

export interface IntegrityIssue {
  kind: IntegrityIssueKind;
  asset_id: Id | null;
  version: number | null;
  path: string | null;
  detail: string;
}

/**
 * system/integrity（data-model §5、sop.md T7）：用写入时的同一个函数对全库复算。
 * `unverifiable` = 非现行版本且按资产当前元数据复算不出原 hash：tags 进了 hash 却没随版本留快照，
 * 这类行无法判定，不算不一致。
 */
export interface IntegrityReport {
  ok: boolean;
  checked_at: string;
  assets: number;
  versions: { total: number; verified: number; unverifiable: number; mismatched: number };
  files: { total: number; mismatched: number };
  fts: { indexed: number; missing: number; stale: number; orphaned: number };
  /** 问题总数；`issues` 超过上限时只回前一段 */
  issue_count: number;
  issues: IntegrityIssue[];
  truncated: boolean;
}

/** system/backup：`VACUUM INTO` 出来的那份副本，落在 hub 的 `<dataDir>/backups/`。 */
export interface BackupInfo {
  file: string;
  path: string;
  bytes: number;
  created_at: string;
}

export interface Verification {
  user: User;
  is_system_admin: boolean;
  teams: { team_id: Id; team: Slug; role: TeamRole }[];
  server_version: string;
}
