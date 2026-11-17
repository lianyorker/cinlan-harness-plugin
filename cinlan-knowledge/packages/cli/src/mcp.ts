import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  KnowledgeRpcError,
  briefInstructions,
  cachedNotice,
  errorInstructions,
  fitInstructions,
} from "@cinlan/knowledge-mcp";
import type { EmbedFn, KnowledgeRpc, McpContext, McpFaceSession } from "@cinlan/knowledge-mcp";
import { makeEmbedder } from "./embeddings.js";
import { isErrorCode } from "@cinlan/knowledge-sdk";
import type { ErrorCode } from "@cinlan/knowledge-sdk";
import { ckHome, type ResolvedConfig } from "./config.js";
import type { HostConfig } from "./hosts.js";
import { logEvent } from "./log.js";
import {
  PrepareError,
  callEnvelope,
  contextOf,
  makeKnowledgeRpc,
  prepare,
  type AgentSpec,
  type PreparedLoadout,
} from "./prepare.js";
import { syncSkills } from "./sync.js";
import { VERSION } from "./version.js";

/**
 * `ck mcp` 的会话装配：prepare → instructions → 后台物化。
 * 与 hub 的 `/mcp`（hub/src/mcp.ts）同一套取法与上报口径：
 * - `brief` 或读档失败 → brief / 错误提示，工具照常可调（`knowledge_status` 是排错入口）；
 * - `full` → 配装文本，缓存兜底时加提示；`fitInstructions` 超限整段退回 brief，不截断；
 * - 文本原样送出且含资产 → 上报一次 `injected`；同 Agent 同 digest 60 秒内只发一次（loadout.md §6）。
 */

export const INJECTED_DEDUPE_MS = 60_000;

export interface McpSessionOptions {
  /** hub / key；缺任何一个都照常起会话，工具返回原因。 */
  config: ResolvedConfig;
  host: HostConfig;
  agent: AgentSpec;
  baseline?: "brief" | "full";
  /**
   * 覆盖用：同时充当 ck 状态目录与宿主路径里 `~` 的展开根。
   * 缺省时两者各取各的：状态目录 ckHome()，`~` 是 os.homedir()。
   */
  home?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** O-9 查询向量注入：缺省从环境（CK_EMBED_URL / CK_EMBED_MODEL / CK_EMBED_KEY）构造。 */
  embed?: EmbedFn;
}

export interface CliSession {
  session: McpFaceSession;
  /** 后台 skill 物化；失败只记日志，不拦工具。 */
  background: Promise<void>;
  prepared: PreparedLoadout | null;
  failure: { code: ErrorCode; message: string } | null;
}

function injectedStatePath(home: string, agentId: string): string {
  return join(home, "cache", `injected-${agentId}.json`);
}

/** 同 Agent 同 digest 在窗口内是否已上报过。 */
function reportedRecently(home: string, agentId: string, digest: string, now: number): boolean {
  const file = injectedStatePath(home, agentId);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { digest?: unknown; at?: unknown };
    return parsed.digest === digest && typeof parsed.at === "number" && now - parsed.at < INJECTED_DEDUPE_MS;
  } catch {
    // 坏文件等同没上报过；下一次成功上报会覆盖它
    return false;
  }
}

function markReported(home: string, agentId: string, digest: string, now: number): void {
  const file = injectedStatePath(home, agentId);
  mkdirSync(join(home, "cache"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ digest, at: now }) + "\n");
  renameSync(tmp, file);
}

function codeOf(err: unknown): ErrorCode {
  if (err instanceof PrepareError) return isErrorCode(err.code) ? err.code : "INTERNAL";
  if (err instanceof KnowledgeRpcError) return err.code;
  return "INTERNAL";
}

/** 没有 hub / key 时的 Rpc：工具照常可调，每次都返回明确原因。 */
function unavailableRpc(code: ErrorCode, detail: string): KnowledgeRpc {
  return {
    server_version: VERSION,
    call: () => Promise.reject(new KnowledgeRpcError(code, detail)),
  };
}

export async function createCliSession(options: McpSessionOptions): Promise<CliSession> {
  const home = options.home ?? ckHome();
  const baseline = options.baseline ?? options.host.instructions;
  const hostName = options.host.name;
  const budgets = options.host.budgets.instructions;

  let prepared: PreparedLoadout | null = null;
  let failure: { code: ErrorCode; message: string } | null = null;
  try {
    prepared = await prepare({
      config: options.config,
      agent: options.agent,
      host: hostName,
      baseline,
      home,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      budgetChars: budgets?.budget_chars,
      maxBytes: budgets?.max_bytes,
    });
  } catch (err) {
    const code = codeOf(err);
    failure = { code, message: (err as Error).message };
    logEvent("mcp.prepare_failed", { host: hostName, agent: `${options.agent.team}/${options.agent.name}`, code, message: failure.message }, home);
  }

  const ctx: McpContext = prepared
    ? contextOf(prepared)
    : {
        agent_id: null,
        agent_name: options.agent.name,
        // 读档失败时拿不到真 team_id；slug 不能当 id 传（与 hub /mcp 的"无事实"口径一致）。
        team_id: null,
        team_name: options.agent.team,
        host: hostName,
        baseline,
      };
  // baseline 的会话级快照（loadout.md §4 第 2 条）：knowledge_status 的 baseline.changed / stale 从这取。
  // brief 不解析（digest 为空串）→ null；读档失败没有 session 事实。
  const sessionFacts = {
    digest: prepared !== null && prepared.digest !== "" ? prepared.digest : null,
    stale: prepared?.stale ?? false,
    skills: null as { materialized: number; conflicts: string[] } | null,
  };
  if (prepared !== null) {
    ctx.session = sessionFacts;
    // knowledge_status 的 current_digest 要与 session digest 同预算解析才可比（§5 的 changed 语义）
    ctx.baseline_budgets = (options.host.budgets.instructions ?? options.host.budgets.hook) !== undefined
      ? {
          budget_chars: (options.host.budgets.instructions ?? options.host.budgets.hook)?.budget_chars,
          max_bytes: options.host.budgets.instructions?.max_bytes,
        }
      : undefined;
  }

  const rpc =
    options.config.hub && options.config.key
      ? makeKnowledgeRpc(options.config.hub, options.config.key, VERSION, options.fetchImpl, prepared?.agent_id)
      : failure
        ? unavailableRpc(failure.code, failure.message)
        : unavailableRpc("UNAUTHORIZED", "hub url or user key not configured: run `ck login --hub <url>`");

  // O-9：环境配了模型端点才注入查询向量（显式 options.embed 覆盖，测试用）；
  // hub /mcp（A0）不带 embed，语义路只在 `ck mcp` 会话里出现。
  const embed = options.embed ?? makeEmbedder();

  // instructions 只在 initialize 时取一次；文本与上报都先算好。
  let delivered: string | null = null;
  const instructions = async (): Promise<string> => {
    if (delivered !== null) return delivered;
    if (prepared === null || failure !== null) {
      delivered = errorInstructions(failure?.code ?? "INTERNAL");
      return delivered;
    }
    if (baseline === "brief") {
      delivered = briefInstructions(ctx);
      return delivered;
    }
    let text = prepared.text;
    if (prepared.stale) text = `${cachedNotice(prepared.fetched_at)}\n${text}`;
    delivered = fitInstructions(text, ctx);
    // 只有原样送出才算"配装已注入"；退回 brief、缓存兜底都不记。
    if (delivered === prepared.text && prepared.items.length > 0) reportInjected();
    return delivered;
  };

  const reportInjected = (): void => {
    if (prepared === null || options.config.hub === null || options.config.key === null) return;
    const now = Date.now();
    if (reportedRecently(home, prepared.agent_id, prepared.digest, now)) return;
    void (async () => {
      try {
        await callEnvelope({
          hub: options.config.hub!,
          key: options.config.key!,
          action: "usage/report",
          body: {
            agent_id: prepared!.agent_id,
            events: prepared!.items.map((item) => ({ asset_id: item.asset_id, version: item.version, kind: "injected" })),
          },
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        });
        markReported(home, prepared!.agent_id, prepared!.digest, now);
      } catch (err) {
        // 记账失败不拦读档，但要留痕（loadout.md §6：stdout 只留协议）
        logEvent("mcp.injected_failed", { agent_id: prepared!.agent_id, message: (err as Error).message }, home);
      }
    })();
  };

  const background = (async (): Promise<void> => {
    if (prepared === null || prepared.skills.length === 0) {
      // 没有要物化的清单也把快照落成「0 已物化」，knowledge_status 的 skills 键才出现
      if (prepared !== null) sessionFacts.skills = { materialized: 0, conflicts: [] };
      return;
    }
    try {
      const result = await syncSkills({
        config: options.config,
        host: options.host,
        agentId: prepared.agent_id,
        skills: prepared.skills,
        // `~` 的展开根是用户 home，不是上面的状态目录；不覆盖时交给 syncSkills 取 os.homedir()
        home: options.home,
        fetchImpl: options.fetchImpl,
      });
      // skipped 里的 unchanged 是"已是最新"，只有 conflict 才是要人处理的事
      const conflicts = result.skipped.filter((s) => s.reason === "conflict");
      sessionFacts.skills = { materialized: result.written.length, conflicts: conflicts.map((s) => s.name) };
      if (conflicts.length > 0) {
        logEvent("mcp.skills_conflict", { agent_id: prepared.agent_id, skipped: conflicts }, home);
      }
    } catch (err) {
      // 物化失败：快照保持 null（knowledge_status 不出 skills 键），文本投递不受影响
      logEvent("mcp.skills_failed", { agent_id: prepared.agent_id, message: (err as Error).message }, home);
    }
  })();

  return { session: { rpc, ctx, instructions, ...(embed !== undefined ? { embed } : {}) }, background, prepared, failure };
}
