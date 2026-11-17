import type { AssetType, ErrorCode } from "@cinlan/knowledge-sdk";

/**
 * MCP 面唯一的外部依赖：一个把动作名落到实现的进程内 Rpc。
 * hub 的 `/mcp` 与 `ck mcp` 各自注入一份，认证、权限、审计都不在这里发生。
 */
export interface KnowledgeRpc {
  /** 与 `POST /api/v1/<action>` 等价；失败时抛出携带错误枚举的 Error。 */
  call(action: string, body: Record<string, unknown>): Promise<unknown>;
  /** `initialize` 用的版本号；与 hub 的 server_version 同源。 */
  server_version: string;
}

/** Rpc 边界上的失败。hub 侧从 DomainError 转出，`ck` 侧从信封转出。 */
export class KnowledgeRpcError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown>;

  constructor(code: ErrorCode, detail: string, data: Record<string, unknown> = {}) {
    super(detail === "" ? code : `${code}: ${detail}`);
    this.name = "KnowledgeRpcError";
    this.code = code;
    this.data = data;
  }
}

/** MCP 面的会话事实：这些来自注入方（hub 从请求头取，ck 从本地配置取）。 */
export interface McpContext {
  /** 本次请求的 Agent；`null` 表示纯用户身份（没有 Agent，读档只到 private 层）。 */
  agent_id: string | null;
  /** Agent 名（slug），用于 brief 标签；缺省回退到 id。 */
  agent_name?: string | null;
  /** 检索 / 创建时的默认团队。 */
  team_id: string | null;
  /** 团队名（slug），用于 brief 标签；缺省回退到 id。 */
  team_name?: string | null;
  /** `x-ck-host` / `host.json` 的宿主名；只用于展示。 */
  host: string | null;
  /** `x-ck-baseline`：`brief` 只发固定引导语，其余发完整配装。 */
  baseline: "brief" | "full";
  /**
   * baseline 完整投递那一路的预算（host.json 的 `instructions` ?? `hook`）。
   * `ck mcp` 注入：knowledge_status 的 `current_digest` 用同一份预算解析，与会话 digest 才可比。
   * hub `/mcp`（A0）可不带（用 hub 缺省预算）。
   */
  baseline_budgets?: { budget_chars?: number; max_bytes?: number };
  /**
   * baseline 的会话级快照事实（loadout.md §4 第 2 条、§5 的 knowledge_status 契约）。
   * `ck mcp` 注入；hub 的 `/mcp`（A0）没有本机状态，不出现——`baseline.changed` 与
   * skill 物化结果随之不出现（loadout.md §5 末条）。skills 物化快照在后台完成后由
   * 注入方回填（`ck mcp` 的后台物化），调用时看到的是当时的进度。
   */
  session?: {
    /** 会话开始时投递的配装文本的 digest；brief 不解析、读档失败为 null。 */
    digest: string | null;
    /** 文本是否来自本机缓存兜底（hub 当时不可达）。 */
    stale: boolean;
    /** skill 物化结果：written 计 materialized，conflict 是要人处理的名字。物化还没跑完为 null。 */
    skills: { materialized: number; conflicts: string[] } | null;
  };
}

export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 20;

/** O-9 通道 A：查询向量的注入点。注入方（`ck mcp`）用环境里的模型端点实现；
 *  hub 的 `/mcp`（A0）不注入——hub 零 LLM。失败时调用方应自行降级为纯 FTS。 */
export type EmbedFn = (text: string) => Promise<number[]>;

export interface SearchHit {
  id: string;
  type: AssetType;
  title: string;
  summary: string;
  snippet: string;
  score: number;
  version: number;
  visibility: string;
  owner: string | null;
  deprecated: boolean;
}

export interface OpenResult {
  id: string;
  type: AssetType;
  title: string;
  version: number;
  content: string;
  files?: { path: string; size: number }[];
}

export interface SaveResult {
  id: string;
  version: number;
  visibility: "private";
}

export interface ShareResult {
  status: "applied" | "pending_review";
  review_id?: string;
}

/** knowledge_session_report：自动沉淀的草稿回执（O-7）。 */
export interface SessionReportResult {
  drafts: { id: string; title: string; visibility: string; status: string }[];
}

export interface StatusResult {
  hub: { ok: boolean; server_version?: string; error?: string };
  user: { id: string; name: string; display_name: string } | null;
  team: { id: string; name: string } | null;
  agent: { id: string; name: string; host: string } | null;
  host: string | null;
  baseline?: {
    delivery: "brief" | "full";
    /** 会话开始时投递的文本 digest（A0 无会话事实时即当前值）；拿不到为 null。 */
    digest: string | null;
    current_digest?: string | null;
    changed?: boolean;
    stale?: boolean;
  };
  loadout?: {
    items: number;
    downgraded: number;
    skipped: { asset_id: string; reason: string }[];
  };
  skills?: { materialized: number; conflicts: string[] };
  reviews?: { pending: number };
  /** `reload: true` 时带完整配装文本。 */
  text?: string;
}
