import type {
  AclEntry,
  AclPermission,
  AclSubjectType,
  Agent,
  Asset,
  AssetHit,
  AssetStatus,
  AssetType,
  AssetVersion,
  AuditRecord,
  BackupInfo,
  Id,
  ImportedAsset,
  ImportStatus,
  InjectionMode,
  IntegrityReport,
  LoadoutBinding,
  MemoryLayer,
  ResolveResult,
  Review,
  ReviewMode,
  SkillFile,
  SystemStats,
  Team,
  TeamMember,
  TeamRole,
  UsageKind,
  UsageGroupBy,
  UsageSummary,
  User,
  UserKeyInfo,
  Verification,
  Visibility,
} from "./entities.js";

/**
 * P1 动作契约。名称即路由：POST /api/v1/<动作>。
 * 入参里的 team_id / user_id 可改传 slug（team / user），两者同时给且不一致 → 400。
 */
export interface Paged {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string;
}

export interface RpcActions {
  // ---- 3.1 身份与团队 ----
  "auth/verify": { req: Record<string, never>; res: Verification };

  "user/create": {
    req: { name: string; display_name: string; is_system_admin?: boolean };
    res: { user: User };
  };
  "user/create-with-key": {
    req: {
      name: string;
      display_name: string;
      is_system_admin?: boolean;
      key_name: string;
      expires_at?: string | null;
    };
    res: { user: User; key: { id: Id; prefix: string; key: string } };
  };
  "user/get": {
    req: { user_id?: Id; user?: string };
    res: { user: User };
  };
  "user/list": {
    req: Paged & { query?: string; status?: "active" | "disabled" };
    res: Page<User>;
  };
  "user/disable": {
    req: { user_id?: Id; user?: string; disabled: boolean };
    res: { user: User };
  };
  "user-key/create": {
    req: {
      user_id?: Id;
      user?: string;
      name: string;
      expires_at?: string | null;
    };
    res: { key: { id: Id; name: string; prefix: string; key: string; expires_at: string | null } };
  };
  "user-key/list": {
    req: { user_id?: Id; user?: string };
    res: { keys: UserKeyInfo[] };
  };
  "user-key/revoke": {
    req: { key_id: Id; user_id?: Id; user?: string };
    res: { revoked: true };
  };

  "team/create": {
    req: { name: string; title: string; description?: string };
    res: { team: Team };
  };
  "team/get": {
    req: { team_id?: Id; team?: string };
    res: { team: Team };
  };
  "team/list": {
    req: Paged;
    res: Page<Team>;
  };
  "team/update": {
    req: {
      team_id?: Id;
      team?: string;
      title?: string;
      description?: string;
      review_mode?: ReviewMode;
      allow_self_approve?: boolean;
    };
    res: { team: Team };
  };
  "team/delete": {
    req: { team_id?: Id; team?: string };
    res: { deleted: true };
  };
  "team-member/add": {
    req: { team_id?: Id; team?: string; user_id?: Id; user?: string; role?: TeamRole };
    res: { member: TeamMember };
  };
  "team-member/remove": {
    req: { team_id?: Id; team?: string; user_id?: Id; user?: string };
    res: { removed: true };
  };
  "team-member/set-role": {
    req: { team_id?: Id; team?: string; user_id?: Id; user?: string; role: TeamRole };
    res: { member: TeamMember };
  };
  "team-member/list": {
    req: { team_id?: Id; team?: string };
    res: { members: TeamMember[] };
  };

  // ---- 3.2 Agent ----
  "agent/ensure": {
    req: { team_id?: Id; team?: string; name: string; host: string; description?: string };
    res: { agent: Agent; created: boolean; template_applied: number };
  };
  "agent/create": {
    req: {
      team_id?: Id;
      team?: string;
      name: string;
      host: string;
      description?: string;
      is_template?: boolean;
    };
    res: { agent: Agent };
  };
  "agent/get": {
    req: { agent_id: Id };
    res: { agent: Agent };
  };
  "agent/update": {
    req: {
      agent_id: Id;
      description?: string;
      host?: string;
      is_template?: boolean;
    };
    res: { agent: Agent };
  };
  "agent/archive": {
    req: { agent_id: Id };
    res: { agent: Agent };
  };
  "agent/list": {
    req: Paged & {
      team_id?: Id;
      team?: string;
      owner_user_id?: Id;
      owner?: string;
      include_archived?: boolean;
    };
    res: Page<Agent>;
  };
  "agent/set-default-template": {
    req: { team_id?: Id; team?: string; agent_id: Id };
    res: { team: Team };
  };
  "agent/get-default-template": {
    req: { team_id?: Id; team?: string };
    res: { agent: Agent | null };
  };

  // ---- 3.3 资产 ----
  "asset/create": {
    req: {
      team_id?: Id;
      team?: string;
      type: AssetType;
      name?: string;
      title: string;
      content: string;
      summary?: string;
      tags?: string[];
      layer?: MemoryLayer;
      files?: SkillFile[];
    };
    res: {
      asset: {
        id: Id;
        version: number;
        visibility: Visibility;
        status: AssetStatus;
        content_hash: string;
      };
    };
  };
  "asset/get": {
    req: { asset_id: Id; version?: number; path?: string };
    res: {
      asset: Asset;
      version: AssetVersion;
      /** skill 的附属文件清单（路径与字节数）；只在不取 `path` 时有意义 */
      files?: { path: string; bytes: number }[];
      file?: { path: string; encoding: string; content: string };
    };
  };
  "asset/update": {
    req: {
      asset_id: Id;
      base_version: number;
      content?: string;
      title?: string;
      summary?: string;
      tags?: string[];
      files?: SkillFile[];
      change_note?: string;
    };
    res:
      | { changed: boolean; version: number }
      | { status: "pending_review"; review_id: Id; proposed_version: number };
  };
  "asset/list": {
    req: Paged & {
      team_id?: Id;
      team?: string;
      type?: AssetType;
      owner_user_id?: Id;
      owner?: string;
      visibility?: Visibility;
      status?: AssetStatus;
      tags?: string[];
    };
    res: Page<Asset>;
  };
  "asset/search": {
    req: {
      query: string;
      team_id?: Id;
      team?: string;
      types?: AssetType[];
      tags?: string[];
      limit?: number;
    };
    res: { hits: AssetHit[] };
  };
  "asset/history": {
    req: { asset_id: Id };
    res: { versions: AssetVersion[] };
  };
  "asset/set-visibility": {
    req: {
      asset_id: Id;
      visibility: Visibility;
      note?: string;
      acl?: { subject_type: AclSubjectType; subject_id: string; permission: AclPermission }[];
    };
    res: { status: "applied" } | { status: "pending_review"; review_id: Id };
  };
  "asset/set-status": {
    req: { asset_id: Id; action: "activate" | "deprecate" | "archive" | "restore"; note?: string };
    res: { asset: Asset } | { status: "pending_review"; review_id: Id };
  };
  "asset/purge": {
    req: { asset_id: Id };
    res: { deleted: true };
  };
  /**
   * P2：导入本机的一个 skill，落成调用者的 private 资产（hosts.md §8、data-model §9）。
   * 匹配键 = 本人在该团队名下的同名 skill；内容是否相同由 hub 按 content_hash 判断。
   * 入参是整份快照而不是补丁：没给的 summary / tags / files 按空算。
   */
  "asset/import": {
    req: {
      team_id?: Id;
      team?: string;
      name: string;
      title: string;
      content: string;
      summary?: string;
      tags?: string[];
      files?: SkillFile[];
      /** 来源宿主（`ck import --source <host>`） */
      host: string;
      /** 本机上该 skill 目录的路径，只作出处记录 */
      import_path: string;
      /** 同名且内容不同时：不给 → `conflict`，资产不动；`new_version` → 出新版本 */
      on_conflict?: "new_version";
    };
    res: { status: ImportStatus; asset: ImportedAsset };
  };
  "acl/grant": {
    req: {
      asset_id: Id;
      subject_type: AclSubjectType;
      subject_id: string;
      permission: AclPermission;
    };
    res: { acl: AclEntry };
  };
  "acl/revoke": {
    req: {
      asset_id: Id;
      subject_type: AclSubjectType;
      subject_id: string;
      permission: AclPermission;
    };
    res: { revoked: true };
  };
  "acl/list": {
    req: { asset_id: Id };
    res: { acl: AclEntry[] };
  };
  "acl/check": {
    req: { asset_id: Id; agent_id?: Id };
    res: { read: boolean; manage: boolean; via: "owner" | "acl" | "role" | "admin" | null };
  };

  // ---- 3.4 配装 ----
  "loadout/get": {
    req: { agent_id: Id };
    res: {
      bindings: (LoadoutBinding & { asset: Asset | null; available: boolean })[];
    };
  };
  "loadout/set": {
    req: {
      agent_id: Id;
      bindings: {
        asset_id: Id;
        priority: number;
        injection_mode: InjectionMode;
        pin_version?: number | null;
      }[];
    };
    res: { bindings: LoadoutBinding[] };
  };
  "loadout/bind": {
    req: {
      agent_id: Id;
      asset_id: Id;
      priority?: number;
      injection_mode?: InjectionMode;
      pin_version?: number | null;
    };
    res: { binding: LoadoutBinding };
  };
  "loadout/unbind": {
    req: { agent_id: Id; asset_id: Id };
    res: { unbound: true };
  };
  "loadout/resolve": {
    req: {
      agent_id: Id;
      if_digest?: string;
      budget_chars?: number;
      max_bytes?: number;
      max_items?: number;
    };
    res: ResolveResult;
  };
  /**
   * P2：团队默认模板下发到已有 Agent（api.md §3.4、architecture.md §4）。
   * `add-missing` 只补目标 Agent 没有的绑定；`replace` 先删目标上 `source = template`
   * 的行再整份拷贝，手工加的绑定不动。requires team admin。
   */
  "loadout/sync-template": {
    req: {
      agent_id: Id;
      mode: "add-missing" | "replace";
    };
    res: {
      /** 新增的绑定条数 */
      applied: number;
      /** replace 时删掉的旧模板绑定条数，add-missing 恒为 0 */
      removed: number;
      template_agent_id: Id;
      bindings: LoadoutBinding[];
    };
  };

  // ---- 3.5 审批、用量 ----
  "review/list": {
    req: Paged & {
      team_id?: Id;
      team?: string;
      mine?: boolean;
      status?: Review["status"];
      kind?: Review["kind"];
    };
    res: Page<Review>;
  };
  "review/get": {
    req: { review_id: Id };
    res: {
      review: Review;
      base: { version: number; title: string; content: string } | null;
      /** update 类审批才有拟议版本；share / retire 为 null */
      proposed: { version: number; title: string; content: string } | null;
    };
  };
  "review/decide": {
    req: { review_id: Id; decision: "approve" | "reject"; reason?: string };
    res: { review: Review };
  };
  "review/withdraw": {
    req: { review_id: Id };
    res: { review: Review };
  };
  "usage/report": {
    req: {
      agent_id: Id;
      events: { asset_id: Id; version: number; kind: UsageKind }[];
    };
    res: { recorded: number };
  };
  /** P2：TA 看本团队，SA 看全部；按 UTC 天聚合的窗口统计。 */
  "usage/summary": {
    req: {
      team_id?: Id;
      team?: string;
      /** 窗口天数，闭区间 [今天-days, 今天]；默认 90，范围 1..180 */
      days?: number;
      group_by?: UsageGroupBy;
    };
    res: UsageSummary;
  };
  /**
   * P2：TA 看本团队，SA 看全部。audit 表没有 team 列，TA 的边界按目标反查：
   * 目标落在本团队的 asset / agent / team / review 才算本团队（SA 不受此限）。
   */
  "audit/list": {
    req: Paged & {
      team_id?: Id;
      team?: string;
      action?: string;
      actor_user_id?: Id;
      actor_agent_id?: Id;
      target_type?: string;
      target_id?: Id;
      /** 闭区间，ISO 时间；按 audit.at 比较 */
      since?: string;
      until?: string;
    };
    res: Page<AuditRecord>;
  };
  /** P2：仅 SA。全库库存统计。 */
  "system/stats": {
    req: Record<string, never>;
    res: SystemStats;
  };
  /** P2：仅 SA。只读复算，不修任何行；恢复备份后必跑（sop.md B.8）。 */
  "system/integrity": {
    req: Record<string, never>;
    res: IntegrityReport;
  };
  /** P2：仅 SA。落点由 hub 定（`<dataDir>/backups/`），调用方不能指定路径；同名文件已存在即拒绝。 */
  "system/backup": {
    req: Record<string, never>;
    res: { backup: BackupInfo };
  };
  /** P3（O-9，通道 A 外置 worker）：把算好的向量写回 hub。owner / 团队管理员 / SA。
   *  version 缺省取资产现行版本；覆盖式写入（旧向量先删）。 */
  "embedding/put": {
    req: { asset_id: Id; version?: number; model: string; vectors: number[][] };
    res: { written: number };
  };
  /** P3（O-9）：回填差集清单——调用者可读、现行版本没有向量的 active 资产。 */
  "embedding/pending": {
    req: Paged & { team?: string; team_id?: Id };
    res: {
      items: {
        asset_id: Id;
        version: number;
        title: string;
        type: AssetType;
        visibility: Visibility;
        updated_at: string;
      }[];
    };
  };
  /** 版本回滚：把资产的现行版本恢复到某个历史版本（内容/标题/摘要/标签/层）。
   *  与 `asset/update` 同门：需要审批的团队走 review 门，直通团队直接生效。
   *  回滚本身也走 update 审批（review kind=update），人审裁决——模型永不全权直写。 */
  "asset/rollback": {
    req: { asset_id: Id; version: number };
    res:
      | { status: "applied"; asset: { id: Id; version: number; visibility: Visibility; status: AssetStatus } }
      | { status: "pending_review"; review_id: Id };
  };
  /** P3（O-7，通道 A' 客户端抽取）：宿主侧模型抽好的候选直落私有草稿。
   *  单次 ≤5 条、整批原子（一条失败全部回滚）；source 记 origin=capture + session_id。 */
  "session/report": {
    req: {
      team?: string;
      team_id?: Id;
      session_id?: string;
      candidates: {
        type: AssetType;
        name?: string;
        title: string;
        content: string;
        summary?: string;
        tags?: string[];
        layer?: MemoryLayer;
      }[];
    };
    res: { drafts: { id: Id; title: string; visibility: Visibility; status: AssetStatus }[] };
  };
  /** P3（O-7）：草稿采纳。activate 直通；带 visibility 时按团队策略可能开共享审批。 */
  "inbox/adopt": {
    req: { asset_id: Id; visibility?: Visibility; note?: string; acl?: AclEntry[] };
    res: { asset_id: Id; status: AssetStatus; visibility: Visibility; review_id: Id | null };
  };
}

export type ActionName = keyof RpcActions;
export type ActionReq<A extends ActionName> = RpcActions[A]["req"];
export type ActionRes<A extends ActionName> = RpcActions[A]["res"];
