import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent, ErrorCode, ResolveResult, User } from "@cinlan/knowledge-sdk";
import type { Db, Principal } from "@cinlan/knowledge-core";
import {
  ensureAgent,
  getAgent,
  getAgentByName,
  getTeamById,
  getTeamByName,
  invalid,
  isDomainError,
  isSlug,
  notFound,
} from "@cinlan/knowledge-core";
import { fail } from "@cinlan/knowledge-sdk";
import {
  INSTRUCTIONS_MAX_BYTES,
  INSTRUCTIONS_MAX_CHARS,
  KnowledgeRpcError,
  briefInstructions,
  createMcpFace,
  errorInstructions,
  fitInstructions,
} from "@cinlan/knowledge-mcp";
import type { KnowledgeRpc, McpContext, McpFaceSession } from "@cinlan/knowledge-mcp";
import { authenticate, originAllowed } from "./auth.js";
import { getHandler } from "./actions.js";
import type { ActionContext } from "./actions.js";
import type { HubConfig } from "./config.js";
import { readBody, sendJson, sendRateLimited } from "./http.js";
import type { RateLimiter } from "./ratelimit.js";

/**
 * `POST /mcp`（api.md §5）：MCP Streamable HTTP，无状态。
 * 认证与 `/api/v1` 相同；工具调用走进程内 Rpc 落到同一张动作注册表，
 * 认证、权限、审计没有第二条路径。传输层错误（400/401/403/404/405/413）仍用统一信封。
 */

export interface McpRouteDeps {
  db: Db;
  config: HubConfig;
  limiter: RateLimiter;
  server_version: string;
}

// 进程内一份：会话状态按请求隔离（见 packages/mcp 的 face.ts），多个 hub 实例共用无妨。
// 正文由 hub 自己按 limits.maxBodyBytes 读完再交给它，所以这里不设 SDK 的正文上限。
const face = createMcpFace({
  onerror: (err) => {
    process.stderr.write(`${JSON.stringify({ level: "warn", via: "mcp", error: err.message })}\n`);
  },
});

/** 转给 MCP SDK 的请求不带 user-key，也不带逐跳头。 */
const DROPPED_HEADERS = new Set(["authorization", "content-length", "transfer-encoding", "connection"]);

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `initialize` 的 `clientInfo.name`：`x-ck-host` 缺省时的宿主名。 */
function clientNameOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const params = (body as { params?: unknown }).params;
  if (params === null || typeof params !== "object") return undefined;
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (clientInfo === null || typeof clientInfo !== "object") return undefined;
  const name = (clientInfo as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** `x-ck-baseline`：缺省 `full`；只认两个值，写错按 400 拒绝而不是静默降级。 */
function baselineOf(req: IncomingMessage): "brief" | "full" | null {
  const value = headerOf(req, "x-ck-baseline");
  if (value === undefined || value === "full") return "full";
  if (value === "brief") return "brief";
  return null;
}

interface AgentFacts {
  agent: Agent;
  team_name: string;
  principal: Principal;
}

/**
 * 解析本次请求的 Agent：
 * - `x-ck-agent: <team-slug>/<agent-name>` → `agent/ensure` 语义（取或建，首次拷贝模板配装）；
 * - `x-ck-agent-id` → 必须是该用户名下的 active Agent；
 * - 都没有 → null（纯用户身份）。
 * 不可见 / 不属于自己 / 已归档一律 NOT_FOUND。
 *
 * `host` 是本请求能确定的宿主名（`x-ck-host`，否则 `initialize` 的 `clientInfo.name`）；
 * 无状态下后续请求两者都可能没有，这时保留库里的值，不把它冲成占位符。
 */
function resolveAgent(base: ActionContext, req: IncomingMessage, host: string | undefined): AgentFacts | null {
  const { db, user } = base;
  const named = headerOf(req, "x-ck-agent");
  const byId = headerOf(req, "x-ck-agent-id");

  if (named !== undefined) {
    const parts = named.split("/");
    const teamName = parts[0];
    const agentName = parts[1];
    if (parts.length !== 2 || teamName === undefined || agentName === undefined || !isSlug(teamName) || !isSlug(agentName)) {
      throw invalid("invalid argument", ["x-ck-agent must be <team-slug>/<agent-name>"]);
    }
    const team = getTeamByName(db, teamName);
    // 团队外的人看不见团队：与 /api/v1 一致，NOT_FOUND 而不是 FORBIDDEN
    if (!team) throw notFound("team not found");

    const existing = getAgentByName(db, team.id, user.id, agentName);
    let agent: Agent;
    if (existing) {
      if (existing.status !== "active") throw notFound("agent not found");
      // 已有：只刷新 host / last_seen_at。这两列只用于统计，与用量同类，不逐请求写审计。
      agent = ensureAgent(db, user, team, { name: agentName, host: host ?? existing.host }).agent;
    } else {
      // 新建：走注册表里的 agent/ensure，成员校验、模板拷贝、审计与 /api/v1 是同一条路径
      const ensure = getHandler("agent/ensure");
      if (!ensure) throw new Error("agent/ensure is not registered");
      const out = ensure(base, { team_id: team.id, name: agentName, host: host ?? "unknown" }) as { agent: Agent };
      agent = out.agent;
    }
    if (byId !== undefined && byId !== agent.id) {
      throw invalid("invalid argument", ["x-ck-agent and x-ck-agent-id disagree"]);
    }
    return {
      agent,
      team_name: team.name,
      principal: { user: { id: user.id }, agent: { id: agent.id, owner_user_id: agent.owner_user_id } },
    };
  }

  if (byId === undefined) return null;
  const agent = getAgent(db, byId);
  if (!agent || agent.owner_user_id !== user.id || agent.status !== "active") {
    throw notFound("agent not found");
  }
  const team = getTeamById(db, agent.team_id);
  if (!team) throw notFound("team not found");
  return {
    agent,
    team_name: team.name,
    principal: { user: { id: user.id }, agent: { id: agent.id, owner_user_id: agent.owner_user_id } },
  };
}

/** 进程内 Rpc：与 `/api/v1/<action>` 执行同一条 handler；错误换成 MCP 面的 `CODE: 说明`。 */
function makeRpc(ctx: ActionContext): KnowledgeRpc {
  return {
    server_version: ctx.server_version,
    async call(action, body) {
      const handler = getHandler(action);
      if (!handler) throw new KnowledgeRpcError("UNKNOWN_ACTION", `unknown action ${action}`);
      try {
        return await handler(ctx, body);
      } catch (err) {
        if (isDomainError(err)) throw new KnowledgeRpcError(err.code, err.detail, err.data);
        // 与 /api/v1 相同：非业务异常一律 INTERNAL，细节只进日志
        process.stderr.write(
          `${JSON.stringify({ level: "error", request_id: ctx.request_id, action, via: "mcp", error: (err as Error).message })}\n`,
        );
        throw new KnowledgeRpcError("INTERNAL", "internal error");
      }
    },
  };
}

function codeOf(err: unknown): ErrorCode {
  return err instanceof KnowledgeRpcError ? err.code : "INTERNAL";
}

/**
 * 握手（`initialize` / `server/discover`）的 instructions：`brief` 或完整配装。
 * 配装按 12,000 字符 / 24,000 字节取；仍超限就整段退回 brief，不截断（loadout.md §7.4）。
 * 完整配装送出后按 data-model §7 记一次 `injected`（A0 由 hub 记）。
 */
async function instructionsFor(rpc: KnowledgeRpc, facts: AgentFacts | null, ctx: McpContext, rid: string): Promise<string> {
  if (ctx.baseline === "brief" || facts === null) return briefInstructions(ctx);
  let resolved: ResolveResult;
  try {
    resolved = (await rpc.call("loadout/resolve", {
      agent_id: facts.agent.id,
      budget_chars: INSTRUCTIONS_MAX_CHARS,
      max_bytes: INSTRUCTIONS_MAX_BYTES,
    })) as ResolveResult;
  } catch (err) {
    return errorInstructions(codeOf(err));
  }
  const text = fitInstructions(resolved.text, ctx);
  if (text === resolved.text && resolved.items.length > 0) {
    try {
      await rpc.call("usage/report", {
        agent_id: facts.agent.id,
        events: resolved.items.map((item) => ({ asset_id: item.asset_id, version: item.version, kind: "injected" })),
      });
    } catch (err) {
      // 记账失败不拦读档，但要留痕
      process.stderr.write(
        `${JSON.stringify({ level: "warn", request_id: rid, via: "mcp", action: "usage/report", error: (err as Error).message })}\n`,
      );
    }
  }
  return text;
}

export async function handleMcp(deps: McpRouteDeps, req: IncomingMessage, res: ServerResponse, rid: string): Promise<void> {
  const reject = (code: ErrorCode, detail: string, extra?: Record<string, unknown>): void => {
    sendJson(res, fail(code, rid, { detail, ...extra }), false);
  };

  if (req.method !== "POST") {
    reject("METHOD_NOT_ALLOWED", "MCP endpoint is stateless POST only");
    return;
  }
  if (!originAllowed(deps.config.listen, req)) {
    reject("FORBIDDEN", "origin not allowed");
    return;
  }
  const auth = authenticate(deps.db, req.headers);
  if (!auth.ok) {
    reject(auth.status, auth.detail);
    return;
  }
  // 与 /api/v1 同一份额度：一次 POST 记一次，工具调用在进程内落到动作表时不再重复计
  const admitted = deps.limiter.hit(auth.principal.key_id);
  if (!admitted.ok) {
    sendRateLimited(res, rid, admitted.retry_after);
    return;
  }
  const body = await readBody(req, deps.config.limits.maxBodyBytes);
  if (!body.ok) {
    reject("PAYLOAD_TOO_LARGE", `body exceeds ${deps.config.limits.maxBodyBytes} bytes`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    reject("INVALID_ARGUMENT", "body is not valid JSON");
    return;
  }
  const baseline = baselineOf(req);
  if (baseline === null) {
    reject("INVALID_ARGUMENT", "x-ck-baseline must be brief or full");
    return;
  }

  const user: User = auth.principal.user;
  const self: ActionContext = {
    db: deps.db,
    user,
    principal: { user: { id: user.id } },
    request_id: rid,
    server_version: deps.server_version,
    data_dir: deps.config.dataDir,
  };
  const host = headerOf(req, "x-ck-host") ?? clientNameOf(parsed);
  let facts: AgentFacts | null;
  try {
    facts = resolveAgent(self, req, host);
  } catch (err) {
    if (!isDomainError(err)) throw err;
    reject(err.code, err.detail, err.data);
    return;
  }

  const ctx: McpContext = {
    agent_id: facts?.agent.id ?? null,
    agent_name: facts?.agent.name ?? null,
    team_id: facts?.agent.team_id ?? null,
    team_name: facts?.team_name ?? null,
    host: facts?.agent.host ?? host ?? null,
    baseline,
  };
  const rpc = makeRpc(facts === null ? self : { ...self, principal: facts.principal });
  const session: McpFaceSession = {
    rpc,
    ctx,
    instructions: () => instructionsFor(rpc, facts, ctx, rid),
  };

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_HEADERS.has(key)) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/mcp"}`;
  const response = await face.fetch(new Request(url, { method: "POST", headers, body: body.text }), session, parsed);

  const bytes = Buffer.from(await response.arrayBuffer());
  const out: Record<string, string | number> = { "content-length": bytes.length, "cache-control": "no-store" };
  const contentType = response.headers.get("content-type");
  if (contentType !== null) out["content-type"] = contentType;
  res.writeHead(response.status, out);
  res.end(bytes);
}
