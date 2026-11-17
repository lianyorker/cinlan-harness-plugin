import { z } from "zod";
import type { AssetHit, MemoryLayer, Review } from "@cinlan/knowledge-sdk";
import type {
  McpContext,
  OpenResult,
  SaveResult,
  SearchHit,
  SessionReportResult,
  ShareResult,
  StatusResult,
} from "./types.js";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, type EmbedFn, type KnowledgeRpc } from "./types.js";

/**
 * 五个工具的唯一实现。入参出参与对应动作同名同义（loadout.md §5），
 * 只做两件映射：`asset_id` → `id`（对模型更短），以及 skill 的 `files[]` 只留路径与大小。
 */

const TOOL_DESCRIPTIONS = {
  knowledge_search:
    "检索团队记忆资产（记忆、技能、流程）。返回标题、摘要与命中片段；需要全文再用 knowledge_open。范围限定为当前身份可读的资产。",
  knowledge_open:
    "读取一条资产的当前版本全文。skill 会另带附属文件列表；要取单个附属文件，传 path。",
  knowledge_save:
    "保存一条记忆（默认仅自己可见）。新建时只需 title 与 content；修改自己已有的资产必须带 id 与 base_version，冲突时返回当前版本号。",
  knowledge_share:
    "把自己的一条资产共享给团队（team）或指定对象（restricted）。可能需要管理员审批，返回 applied 或 pending_review。",
  knowledge_status:
    "自检：hub 连通性、当前用户 / 团队 / Agent / 宿主、配装摘要、待我处理的审批。hub 不可达或 key 失效时也照常返回原因。reload=true 时另带完整配装文本。",
  knowledge_session_report:
    "把本轮对话里有沉淀价值的内容报给知识库（自动沉淀）。候选须独立成句、脱离对话也能看懂；落为仅自己可见的草稿，在面板收件箱采纳后才进入检索。单次最多 5 条。",
} as const;

export interface ToolDeps {
  rpc: KnowledgeRpc;
  ctx: McpContext;
  /** O-9：注入方提供了才会走语义路；hub `/mcp` 不带。 */
  embed?: EmbedFn;
}

/** memory 的分层取值（data-model.md §8）；类型钉在 sdk 的 MemoryLayer 上，写错值编译不过。 */
const MEMORY_LAYERS = ["core", "profile", "atom"] as const satisfies readonly MemoryLayer[];

/** 工具错误：MCP 的 isError 文本固定为「错误枚举: 说明」，不吞错。 */
class ToolError extends Error {}

function rethrow(err: unknown): never {
  if (err instanceof Error) throw err;
  throw new ToolError("INTERNAL: unknown error");
}

async function call(deps: ToolDeps, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return (await deps.rpc.call(action, body)) as Record<string, unknown>;
  } catch (err) {
    rethrow(err);
  }
}

function toHit(h: AssetHit): SearchHit {
  return {
    id: h.asset_id,
    type: h.type,
    title: h.title,
    summary: h.summary,
    snippet: h.snippet,
    score: h.score,
    version: h.version,
    visibility: h.visibility,
    owner: h.owner?.name ?? null,
    deprecated: h.deprecated,
  };
}

export const searchTool = {
  name: "knowledge_search",
  description: TOOL_DESCRIPTIONS.knowledge_search,
  inputSchema: z.object({
    query: z.string().min(1).describe("检索词；中文两字也有效"),
    types: z.array(z.enum(["memory", "skill", "wiki", "codegraph"])).optional().describe("限定资产类型"),
    tags: z.array(z.string()).optional().describe("按标签收窄"),
    limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional().describe(`返回条数，默认 ${SEARCH_LIMIT_DEFAULT}`),
  }),
  async run(deps: ToolDeps, input: { query: string; types?: string[]; tags?: string[]; limit?: number }): Promise<{ hits: SearchHit[] }> {
    const body: Record<string, unknown> = {
      query: input.query,
      limit: input.limit ?? SEARCH_LIMIT_DEFAULT,
    };
    if (input.types !== undefined) body["types"] = input.types;
    if (input.tags !== undefined) body["tags"] = input.tags;
    if (deps.ctx.team_id !== null) body["team_id"] = deps.ctx.team_id;
    // O-9 双路：注入了 embed 就把查询文本转向量，hub 侧 FTS+KNN 做 RRF。
    // 向量化失败（端点暂时不可达）降级纯 FTS——检索可用性优先于语义增益。
    if (deps.embed !== undefined) {
      try {
        body["query_embedding"] = await deps.embed(input.query);
      } catch {
        // 降级；不吞掉检索本身
      }
    }
    const out = await call(deps, "asset/search", body);
    return { hits: (out["hits"] as AssetHit[]).map(toHit) };
  },
};

export const openTool = {
  name: "knowledge_open",
  description: TOOL_DESCRIPTIONS.knowledge_open,
  inputSchema: z.object({
    id: z.string().min(1).describe("资产 id"),
    path: z.string().min(1).optional().describe("skill 附属文件路径；留空取主文件"),
  }),
  async run(deps: ToolDeps, input: { id: string; path?: string }): Promise<OpenResult> {
    const body: Record<string, unknown> = { asset_id: input.id };
    if (input.path !== undefined) body["path"] = input.path;
    const out = await call(deps, "asset/get", body);
    const asset = out["asset"] as { id: string; type: OpenResult["type"]; title: string };
    const version = out["version"] as { version: number; content: string };
    const result: OpenResult = {
      id: asset.id,
      type: asset.type,
      title: asset.title,
      version: version.version,
      content: version.content,
    };
    const file = out["file"] as { path: string; encoding: string; content: string } | undefined;
    if (file !== undefined) {
      // 取单个附属文件：正文是该文件内容，主文件内容让位
      result.content = file.content;
      result.files = [{ path: file.path, size: Buffer.byteLength(file.content, "utf8") }];
    } else if (asset.type === "skill") {
      const files = out["files"] as { path: string; bytes: number }[] | undefined;
      if (files !== undefined && files.length > 0) {
        result.files = files.map((f) => ({ path: f.path, size: f.bytes }));
      }
    }
    return result;
  },
};

export const saveTool = {
  name: "knowledge_save",
  description: TOOL_DESCRIPTIONS.knowledge_save,
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe("一句话说清这条记忆是什么"),
    content: z.string().min(1).describe("正文"),
    tags: z.array(z.string()).optional().describe("标签，最多 16 个"),
    layer: z.enum(MEMORY_LAYERS).optional().describe("记忆分层，默认 atom"),
    id: z.string().optional().describe("修改自己已有资产时给 id"),
    base_version: z.number().int().min(1).optional().describe("与 id 同用：我修改时基于的版本号"),
  }),
  async run(
    deps: ToolDeps,
    input: { title: string; content: string; tags?: string[]; layer?: MemoryLayer; id?: string; base_version?: number },
  ): Promise<SaveResult | Record<string, unknown>> {
    if (input.id !== undefined) {
      if (input.base_version === undefined) {
        throw new ToolError("INVALID_ARGUMENT: 修改已有资产必须带 base_version（先用 knowledge_open 取当前版本）");
      }
      return await call(deps, "asset/update", {
        asset_id: input.id,
        base_version: input.base_version,
        title: input.title,
        content: input.content,
        tags: input.tags,
      });
    }
    if (deps.ctx.team_id === null) {
      throw new ToolError("INVALID_ARGUMENT: 当前身份没有可写入的团队；先用 ck setup 指定 --agent <team>/<name>");
    }
    const out = await call(deps, "asset/create", {
      team_id: deps.ctx.team_id,
      type: "memory",
      title: input.title,
      content: input.content,
      tags: input.tags,
      layer: input.layer ?? "atom",
    });
    const asset = out["asset"] as { id: string; version: number; visibility: "private" };
    return { id: asset.id, version: asset.version, visibility: asset.visibility };
  },
};

export const shareTool = {
  name: "knowledge_share",
  description: TOOL_DESCRIPTIONS.knowledge_share,
  inputSchema: z.object({
    id: z.string().min(1).describe("资产 id"),
    visibility: z.enum(["team", "restricted"]).describe("共享范围"),
    note: z.string().optional().describe("为什么需要共享；给审批人看"),
    acl: z
      .array(
        z.object({
          subject_type: z.enum(["user", "role", "agent"]),
          subject_id: z.string(),
          permission: z.enum(["read", "manage"]),
        }),
      )
      .optional()
      .describe("visibility=restricted 时必填（已在 restricted 上的可省略）"),
  }),
  async run(
    deps: ToolDeps,
    input: { id: string; visibility: "team" | "restricted"; note?: string; acl?: unknown[] },
  ): Promise<ShareResult> {
    const body: Record<string, unknown> = { asset_id: input.id, visibility: input.visibility };
    if (input.note !== undefined) body["note"] = input.note;
    if (input.acl !== undefined) body["acl"] = input.acl;
    const out = await call(deps, "asset/set-visibility", body);
    if (out["status"] === "pending_review") {
      return { status: "pending_review", review_id: out["review_id"] as string };
    }
    return { status: "applied" };
  },
};

export const statusTool = {
  name: "knowledge_status",
  description: TOOL_DESCRIPTIONS.knowledge_status,
  inputSchema: z.object({
    reload: z.boolean().optional().describe("true 时返回完整配装文本"),
  }),
  async run(deps: ToolDeps, input: { reload?: boolean }): Promise<StatusResult> {
    // 排错入口：任何一步失败都记录原因并继续，绝不整体失败
    const out: StatusResult = {
      hub: { ok: false },
      user: null,
      team: null,
      agent: null,
      host: deps.ctx.host,
    };
    try {
      const verify = await call(deps, "auth/verify", {});
      out.hub = { ok: true, server_version: verify["server_version"] as string };
      const user = verify["user"] as { id: string; name: string; display_name: string };
      out.user = { id: user.id, name: user.name, display_name: user.display_name };
      const teams = verify["teams"] as { team_id: string; team: string; role: string }[];
      if (deps.ctx.team_id !== null) {
        const match = teams.find((t) => t.team_id === deps.ctx.team_id);
        if (match !== undefined) out.team = { id: match.team_id, name: match.team };
      }
    } catch (err) {
      out.hub = { ok: false, error: err instanceof Error ? err.message : String(err) };
      return out;
    }

    if (deps.ctx.agent_id !== null) {
      try {
        const agent = await call(deps, "agent/get", { agent_id: deps.ctx.agent_id });
        const a = agent["agent"] as { id: string; name: string; host: string; status: string };
        out.agent = { id: a.id, name: a.name, host: a.host };
        // 团队名可由 Agent 反查，摆脱 verify.teams 的依赖
        if (out.team === null && deps.ctx.team_id !== null) out.team = { id: deps.ctx.team_id, name: "" };
        const resolved = await call(deps, "loadout/resolve", {
          agent_id: a.id,
          ...(deps.ctx.baseline_budgets?.budget_chars !== undefined ? { budget_chars: deps.ctx.baseline_budgets.budget_chars } : {}),
          ...(deps.ctx.baseline_budgets?.max_bytes !== undefined ? { max_bytes: deps.ctx.baseline_budgets.max_bytes } : {}),
        });
        // baseline 是会话级快照（loadout.md §4 第 2 条）：digest 是会话开始时投递的那份，
        // current_digest 是 hub 现算的；经远端 /mcp（A0）调用时没有本机状态，`current_digest` /
        // `changed` / `stale` 与 skill 物化结果不出现（loadout.md §5 末条），digest 即当前值。
        const current = typeof resolved["digest"] === "string" ? (resolved["digest"] as string) : null;
        const session = deps.ctx.session;
        if (session === undefined) {
          out.baseline = { delivery: deps.ctx.baseline, digest: current };
        } else {
          const digest = session.digest;
          out.baseline = {
            delivery: deps.ctx.baseline,
            digest,
            current_digest: current,
            changed: digest !== null && current !== null && digest !== current,
            stale: session.stale,
          };
        }
        out.loadout = {
          items: (resolved["items"] as unknown[]).length,
          downgraded: (resolved["downgraded"] as number | undefined) ?? 0,
          skipped: (resolved["skipped"] as { asset_id: string; reason: string }[]).map((s) => ({ asset_id: s.asset_id, reason: s.reason })),
        };
        // skill 物化快照：后台还没跑完（或 A0 没有物化）时不出现这个键（loadout.md §5）
        if (session?.skills != null) out.skills = session.skills;
        if (input.reload === true) out.text = resolved["text"] as string;
      } catch (err) {
        // Agent 不可用不阻塞其余状态
        out.baseline = { delivery: deps.ctx.baseline, digest: null };
        out.text = err instanceof Error ? err.message : String(err);
      }
    }

    try {
      const reviews = await call(deps, "review/list", { mine: true, status: "pending" });
      const items = reviews["items"] as Review[];
      out.reviews = { pending: items.length };
    } catch {
      // 没有审批权限时正常返回，不视为错误
    }
    return out;
  },
};

export const sessionReportTool = {
  name: "knowledge_session_report",
  description: TOOL_DESCRIPTIONS.knowledge_session_report,
  inputSchema: z.object({
    candidates: z
      .array(
        z.object({
          title: z.string().min(1).max(120).describe("一句话说清这条记忆是什么"),
          content: z.string().min(1).describe("正文；独立成句，不带对话上下文指代"),
          layer: z.enum(MEMORY_LAYERS).optional().describe("记忆分层，默认 atom"),
          tags: z.array(z.string()).optional().describe("标签，最多 16 个"),
        }),
      )
      .min(1)
      .max(5)
      .describe("候选记忆；一条只说一件事"),
    session_id: z.string().min(1).max(200).optional().describe("会话标识（证据溯源用，可省略）"),
  }),
  async run(
    deps: ToolDeps,
    input: { candidates: { title: string; content: string; layer?: MemoryLayer; tags?: string[] }[]; session_id?: string },
  ): Promise<SessionReportResult> {
    if (deps.ctx.team_id === null) {
      throw new ToolError("INVALID_ARGUMENT: 当前身份没有可写入的团队；先用 ck setup 指定 --agent <team>/<name>");
    }
    const out = await call(deps, "session/report", {
      team_id: deps.ctx.team_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      candidates: input.candidates.map((c) => ({
        type: "memory",
        title: c.title,
        content: c.content,
        layer: c.layer ?? "atom",
        ...(c.tags !== undefined ? { tags: c.tags } : {}),
      })),
    });
    return { drafts: out["drafts"] as SessionReportResult["drafts"] };
  },
};

export const TOOLS = [searchTool, openTool, saveTool, shareTool, statusTool, sessionReportTool] as const;
