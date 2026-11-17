import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolveResult } from "@cinlan/knowledge-sdk";
import { isErrorCode } from "@cinlan/knowledge-sdk";
import type { KnowledgeRpc, McpContext } from "@cinlan/knowledge-mcp";
import { KnowledgeRpcError } from "@cinlan/knowledge-mcp";
import type { ResolvedConfig } from "./config.js";
import { ckHome } from "./config.js";
import { rpc } from "./rpc.js";

/**
 * 读档流水线（loadout.md §6）：配置 → 身份 → 解析 → 缓存。
 * `ck mcp` 与 `ck hook session-start` 共用；skill 物化在 skills.ts，与本文件解耦。
 */

/** 一个 `--agent <team>/<name>` 取值。 */
export interface AgentSpec {
  team: string;
  name: string;
}

export function parseAgent(value: string): AgentSpec {
  const at = value.indexOf("/");
  if (at <= 0 || at === value.length - 1) {
    throw new Error(`--agent must be <team>/<name>, got "${value}"`);
  }
  const team = value.slice(0, at);
  const name = value.slice(at + 1);
  if (team.includes("/") || name.includes("/")) throw new Error(`--agent must be <team>/<name>, got "${value}"`);
  return { team, name };
}

export interface PreparedLoadout {
  agent_id: string;
  agent_name: string;
  /** 团队 id（`tem_…`）；下游动作的 `team_id` 入参只认 id，不认 slug。 */
  team_id: string;
  /** 团队 slug；brief 标签与展示用。 */
  team_name: string;
  host: string;
  baseline: "brief" | "full";
  text: string;
  /** 文本来自本机缓存、hub 本次不可达。 */
  stale: boolean;
  fetched_at: string;
  digest: string;
  items: { asset_id: string; version: number }[];
  /** 物化用：hub 返回的 skill 清单（缓存时也可能是旧值）。 */
  skills: ResolveResult["skills"];
}

export interface PrepareOptions {
  config: ResolvedConfig;
  agent: AgentSpec;
  host: string;
  baseline?: "brief" | "full";
  /** 解析步骤合计时限，默认 3s（CK_TIMEOUT_MS 可调）。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 本机状态目录；缺省 ckHome()。 */
  home?: string;
  /** 预算，取自 host.json；缺省交给 hub 的 DEFAULTS。 */
  budgetChars?: number;
  maxBytes?: number;
  /**
   * 本次结果必须来自 hub：缓存不当读取来源——不带 `if_digest`（跳过 `not_modified` 短路），
   * hub 不可达时也不拿缓存兜底；解析成功照常写缓存。只对 `full` 有意义（`brief` 不解析）。
   */
  fresh?: boolean;
}

export function loadoutCachePath(home: string, agentId: string): string {
  return join(home, "cache", `loadout-${agentId}.json`);
}

interface CacheFile {
  digest: string;
  text: string;
  items: { asset_id: string; version: number }[];
  skills: ResolveResult["skills"];
  fetched_at: string;
}

function readCache(home: string, agentId: string): CacheFile | null {
  const file = loadoutCachePath(home, agentId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (typeof parsed.digest !== "string" || typeof parsed.text !== "string") return null;
    return {
      digest: parsed.digest,
      text: parsed.text,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      fetched_at: typeof parsed.fetched_at === "string" ? parsed.fetched_at : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function dropCache(home: string, agentId: string): void {
  rmSync(loadoutCachePath(home, agentId), { force: true });
}

async function writeCacheAtomic(home: string, agentId: string, data: CacheFile): Promise<void> {
  const { mkdirSync, renameSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(home, "cache"), { recursive: true });
  const file = loadoutCachePath(home, agentId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * `<team>/<name>` → agent_id 的本机备忘。缓存按 agent_id 存放，而 agent_id 只有 `agent/ensure` 给得出：
 * ensure 自己失败时（hub 不可达 / key 被吊销）靠它找回该 Agent 的缓存——前者读，后者删。
 * 文件名带 hub：agent_id 只在签发它的 hub 上有意义。
 */
export function agentMemoPath(home: string, hub: string, agent: AgentSpec): string {
  const key = createHash("sha256").update(`${hub}\n${agent.team}/${agent.name}`).digest("hex").slice(0, 16);
  return join(home, "cache", `agent-${key}.json`);
}

interface AgentMemo {
  agent_id: string;
  team_id: string;
}

function readAgentMemo(home: string, hub: string, agent: AgentSpec): AgentMemo | null {
  const file = agentMemoPath(home, hub, agent);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AgentMemo>;
    if (typeof parsed.agent_id !== "string" || typeof parsed.team_id !== "string") return null;
    return { agent_id: parsed.agent_id, team_id: parsed.team_id };
  } catch {
    // 坏文件等同没记过；下一次 ensure 成功会覆盖它
    return null;
  }
}

function rememberAgent(home: string, hub: string, agent: AgentSpec, memo: AgentMemo): void {
  const known = readAgentMemo(home, hub, agent);
  if (known !== null && known.agent_id === memo.agent_id && known.team_id === memo.team_id) return;
  mkdirSync(join(home, "cache"), { recursive: true });
  const file = agentMemoPath(home, hub, agent);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(memo) + "\n");
  renameSync(tmp, file);
}

function isRevoked(err: unknown): boolean {
  return (
    err instanceof KnowledgeRpcError &&
    (err.code === "UNAUTHORIZED" || err.code === "FORBIDDEN" || err.code === "NOT_FOUND")
  );
}

/**
 * prepare 的失败出口：调用方（hook / mcp）据此决定输出错误提示块还是继续提供工具。
 * `code` 是错误枚举；网络故障统一记 `UNAVAILABLE`。
 */
export class PrepareError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrepareError";
  }
}

/** 调动作并把非 0 信封转成 KnowledgeRpcError（与 MCP 面的 Rpc 边界同构）。 */
export async function callEnvelope(options: {
  hub: string;
  key: string;
  action: string;
  body: Record<string, unknown>;
  /** 带上则以该 Agent 的身份调用（`x-ck-agent-id`）。 */
  agentId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  let env;
  try {
    env = await rpc({
      hub: options.hub,
      key: options.key,
      action: options.action,
      body: options.body,
      agentId: options.agentId,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    throw new PrepareError("UNAVAILABLE", (err as Error).message);
  }
  if (env.code !== 0) {
    // code != 0 时 message 一定是错误枚举；isErrorCode 只是给类型收窄。
    const code = isErrorCode(env.message) ? env.message : "INTERNAL";
    // 信封把人读说明放在 data.detail；拆出来还给 detail，错误文本才与 hub `/mcp` 同形（`CODE: 说明`）。
    const { detail, ...rest } = (env.data ?? {}) as Record<string, unknown>;
    throw new KnowledgeRpcError(code, typeof detail === "string" ? detail : "", rest);
  }
  return (env.data ?? {}) as Record<string, unknown>;
}

export async function prepare(options: PrepareOptions): Promise<PreparedLoadout> {
  const { config, agent, host } = options;
  if (!config.hub) throw new PrepareError("UNAVAILABLE", "hub url not configured: set CK_HUB_URL or run `ck login --hub <url>`");
  if (!config.key) throw new PrepareError("UNAUTHORIZED", "user key not configured: set CK_USER_KEY or run `ck login --hub <url>`");
  const home = options.home ?? ckHome();
  const baseline = options.baseline ?? "full";
  const timeoutMs = options.timeoutMs ?? 3000;
  // 时限是 ensure + resolve 合计（loadout.md §6）：resolve 只拿 ensure 用剩的部分
  const deadline = Date.now() + timeoutMs;
  const hub = config.hub;
  const key = config.key;

  let ensured: Record<string, unknown>;
  try {
    ensured = await callEnvelope({
      hub,
      key,
      action: "agent/ensure",
      body: { team: agent.team, name: agent.name, host },
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    // ensure 失败拿不到 agent_id；缓存规则（loadout.md §6）照样要兑现，靠备忘找回这个 Agent。
    const known = readAgentMemo(home, hub, agent);
    if (isRevoked(err)) {
      if (known) dropCache(home, known.agent_id);
      throw new PrepareError((err as KnowledgeRpcError).code, (err as Error).message);
    }
    const fallback = known !== null && baseline === "full" && !options.fresh ? readCache(home, known.agent_id) : null;
    if (known !== null && fallback !== null) {
      return {
        agent_id: known.agent_id,
        agent_name: agent.name,
        team_id: known.team_id,
        team_name: agent.team,
        host,
        baseline,
        text: fallback.text,
        stale: true,
        fetched_at: fallback.fetched_at,
        digest: fallback.digest,
        items: fallback.items,
        skills: fallback.skills,
      };
    }
    if (err instanceof PrepareError) throw err;
    throw new PrepareError((err as KnowledgeRpcError).code, (err as Error).message);
  }
  const out = ensured["agent"] as { id?: unknown; team_id?: unknown } | undefined;
  if (typeof out?.id !== "string") throw new PrepareError("INTERNAL", "agent/ensure returned no agent id");
  if (typeof out.team_id !== "string") throw new PrepareError("INTERNAL", "agent/ensure returned no team id");
  const agentId = out.id;
  // 下游动作的 team_id 入参只认 id；slug 只用于标签（与 hub /mcp 的 ctx 口径一致）。
  const teamId = out.team_id;
  // brief 不用缓存，也就不需要备忘；保持它不写本机状态。
  if (baseline === "full") rememberAgent(home, hub, agent, { agent_id: agentId, team_id: teamId });

  // fresh：缓存本次不当读取来源，下面的 if_digest 与网络兜底随之都不走
  const cached = options.fresh ? null : readCache(home, agentId);

  // brief 不落缓存：它不含资产，重算成本为零。
  if (baseline === "brief") {
    return {
      agent_id: agentId,
      agent_name: agent.name,
      team_id: teamId,
      team_name: agent.team,
      host,
      baseline,
      text: "",
      stale: false,
      fetched_at: new Date().toISOString(),
      digest: "",
      items: [],
      skills: cached?.skills ?? [],
    };
  }

  let resolved: ResolveResult;
  try {
    const data = await callEnvelope({
      hub,
      key,
      action: "loadout/resolve",
      body: {
        agent_id: agentId,
        ...(cached ? { if_digest: cached.digest } : {}),
        ...(options.budgetChars !== undefined ? { budget_chars: options.budgetChars } : {}),
        ...(options.maxBytes !== undefined ? { max_bytes: options.maxBytes } : {}),
      },
      timeoutMs: Math.max(0, deadline - Date.now()),
      fetchImpl: options.fetchImpl,
    });
    resolved = data as unknown as ResolveResult;
  } catch (err) {
    if (isRevoked(err)) {
      // 吊销 / 禁用 / 归档：缓存不能继续当读档来源（loadout.md §6 最后一行）。
      dropCache(home, agentId);
      throw new PrepareError((err as KnowledgeRpcError).code, (err as Error).message);
    }
    if (cached) {
      return {
        agent_id: agentId,
        agent_name: agent.name,
        team_id: teamId,
        team_name: agent.team,
        host,
        baseline,
        text: cached.text,
        stale: true,
        fetched_at: cached.fetched_at,
        digest: cached.digest,
        items: cached.items,
        skills: cached.skills,
      };
    }
    throw new PrepareError((err as KnowledgeRpcError).code ?? "UNAVAILABLE", (err as Error).message);
  }

  if (resolved.not_modified) {
    if (!cached) throw new PrepareError("INTERNAL", "hub reported not_modified but no cache exists");
    // 文本沿用缓存（digest 相同即逐字节相同）；清单取本次应答——skill 升版本不改文本、
    // digest 不变，hub 在 not_modified 里也返回 skills[] / items[]（acceptance-report §5.4）。
    // 清单有变时把缓存一并刷新，网络兜底那条路的清单才不会退回旧版本。
    const items = resolved.items.map((i) => ({ asset_id: i.asset_id, version: i.version }));
    const listChanged =
      JSON.stringify(items) !== JSON.stringify(cached.items) || JSON.stringify(resolved.skills) !== JSON.stringify(cached.skills);
    if (listChanged) {
      await writeCacheAtomic(home, agentId, {
        digest: cached.digest,
        text: cached.text,
        items,
        skills: resolved.skills,
        fetched_at: cached.fetched_at,
      });
    }
    return {
      agent_id: agentId,
      agent_name: agent.name,
      team_id: teamId,
      team_name: agent.team,
      host,
      baseline,
      text: cached.text,
      stale: false,
      fetched_at: cached.fetched_at,
      digest: cached.digest,
      items,
      skills: resolved.skills,
    };
  }

  const fetchedAt = new Date().toISOString();
  const items = resolved.items.map((i) => ({ asset_id: i.asset_id, version: i.version }));
  await writeCacheAtomic(home, agentId, {
    digest: resolved.digest,
    text: resolved.text,
    items,
    skills: resolved.skills,
    fetched_at: fetchedAt,
  });

  return {
    agent_id: agentId,
    agent_name: agent.name,
    team_id: teamId,
    team_name: agent.team,
    host,
    baseline,
    text: resolved.text,
    stale: false,
    fetched_at: fetchedAt,
    digest: resolved.digest,
    items,
    skills: resolved.skills,
  };
}

/** 从 prepare 结果造 MCP 会话事实。 */
export function contextOf(prepared: PreparedLoadout): McpContext {
  return {
    agent_id: prepared.agent_id,
    agent_name: prepared.agent_name,
    team_id: prepared.team_id,
    team_name: prepared.team_name,
    host: prepared.host,
    baseline: prepared.baseline,
  };
}

/**
 * 把 `ck` 的 HTTP 调用包成 mcp 包的 `KnowledgeRpc`。
 * `agentId` 是会话的 Agent：工具调用必须带着它，权限与 `opened` 记账才和 hub `/mcp` 一致。
 */
export function makeKnowledgeRpc(
  hub: string,
  key: string,
  serverVersion: string,
  fetchImpl?: typeof fetch,
  agentId?: string,
): KnowledgeRpc {
  return {
    server_version: serverVersion,
    async call(action, body) {
      return callEnvelope({ hub, key, action, body, agentId, fetchImpl });
    },
  };
}
