import type { ResolvedConfig } from "./config.js";
import { callEnvelope } from "./prepare.js";

/**
 * `ck reflect`（v2 深层记忆智能，deep-memory.md §3 第 1 条）：跨会话抽象再加工。
 * 读目标资产 + 同团队最近的沉淀草稿 → 交给 LLM（客户端调用，hub 零 LLM）→
 * 产出三类提议，全部走现有审批/草稿机制——**模型永不全权直写团队上下文**：
 *   1. 资产更新提议 → `asset/update`（base_version 带上 → 走 review 门）
 *   2. 新 atom 草稿 → `session/report`（私有草稿，人审采纳）
 *   3. 矛盾/过时提示 → 仅输出，不做任何动作
 *
 * 触发：手动（本命令）。批处理/定时等真实使用有需求再加。
 */

/** 每次最多读的草稿条数（session/report 的沉淀，按时间倒序）。 */
const DRAFT_LIMIT = 20;

export interface ReflectOptions {
  config: ResolvedConfig;
  /** openai-compatible base URL（chat/completions）。 */
  url: string;
  model: string;
  apiKey?: string;
  /** 目标资产 id（必填；reflect 的是「这条资产该怎么改进」）。 */
  assetId: string;
  /** 团队 slug（可选，缺省从资产自动取）。 */
  team?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ReflectTeamOptions {
  config: ResolvedConfig;
  /** openai-compatible base URL（chat/completions）。 */
  url: string;
  model: string;
  apiKey?: string;
  /** 团队 slug（必填）。 */
  team: string;
  /** 最多跑多少条资产（默认 10）。 */
  limit?: number;
  dryRun?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ReflectProposals {
  asset_updates: {
    title: string;
    content: string;
    reason: string;
  }[];
  new_atoms: {
    title: string;
    content: string;
    reason: string;
  }[];
  contradictions: {
    description: string;
    existing: string;
    proposed: string;
  }[];
}

export interface ReflectReport {
  ok: boolean;
  asset_id: string;
  asset_title: string;
  drafts_read: number;
  proposals: ReflectProposals;
  submitted: {
    updates: number;
    atoms: number;
    review_ids: string[];
  };
  errors: string[];
}

/** 组装发给 LLM 的 system + user prompt（导出测试用）。 */
export function buildReflectPrompt(input: {
  assetTitle: string;
  assetContent: string;
  drafts: { title: string; content: string; session_id?: string }[];
}): { system: string; user: string } {
  const system = [
    "你是团队知识管理助手。分析当前团队知识资产和最近会话中的新发现，产出结构化的改进提议。",
    "你只提建议，不做决定——所有提议都由人审裁决。",
    "输出必须是合法 JSON，不要包裹 markdown 代码块。",
    "JSON 形状：",
    JSON.stringify(
      {
        asset_updates: [
          {
            title: "更新后的完整标题（不改就照抄）",
            content: "更新后的完整正文（保留原有有效内容，合并新信息，删除过时部分）",
            reason: "为什么这样改",
          },
        ],
        new_atoms: [
          {
            title: "独立知识点的标题",
            content: "独立成句的事实/结论（脱离对话也能看懂）",
            reason: "为什么应该单独记",
          },
        ],
        contradictions: [
          {
            description: "矛盾描述",
            existing: "当前资产里的说法",
            proposed: "新发现的说法",
          },
        ],
      },
      null,
      2,
    ),
    "字段可以是空数组；如果不需要更新，asset_updates 为空。",
  ].join("\n");

  const draftLines = input.drafts
    .map((d, i) => `${i + 1}. [${d.title}]${d.session_id ? ` (session: ${d.session_id})` : ""}\n   ${d.content.slice(0, 500)}`)
    .join("\n\n");

  const user = [
    `当前团队资产：${input.assetTitle}`,
    "---",
    input.assetContent,
    "",
    input.drafts.length > 0 ? `最近的会话沉淀（草稿，尚未采纳）：\n${draftLines}` : "（暂无会话沉淀）",
    "",
    "请分析以上内容，按 JSON 形状产出改进提议。",
  ].join("\n");

  return { system, user };
}

/** 解析 LLM 应答里的 JSON（容错：剥掉 markdown 围栏、截取首个 { 到末个 }）。 */
export function parseReflectResponse(text: string): ReflectProposals {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM 应答里没有 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<ReflectProposals>;
  return {
    asset_updates: Array.isArray(parsed.asset_updates) ? parsed.asset_updates : [],
    new_atoms: Array.isArray(parsed.new_atoms) ? parsed.new_atoms : [],
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
  };
}

async function chatCompletion(
  options: { url: string; model: string; apiKey?: string; fetchImpl?: typeof fetch },
  system: string,
  user: string,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${options.url.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
    }),
  // 不用全局 keep-alive 连接池——reflect 的 LLM 调用频率低，一次性连接即可，也避免测试进程挂住
    signal: AbortSignal.timeout(120_000),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`LLM 端点 ${res.status}: ${bodyText.slice(0, 200)}`);
  const parsed = JSON.parse(bodyText) as { choices?: { message?: { content?: string } }[] };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("LLM 端点没有返回文本");
  return content;
}

export async function runReflect(options: ReflectOptions): Promise<ReflectReport> {
  const hub = { hub: options.config.hub!, key: options.config.key!, timeoutMs: options.timeoutMs, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) };

  // 1) 读目标资产
  const detail = (await callEnvelope({ ...hub, action: "asset/get", body: { asset_id: options.assetId } })) as {
    asset: { id: string; title: string; team_id: string; current_version: number; visibility: string };
    version: { version: number; content: string };
  };
  const teamId = detail.asset.team_id;

  // 2) 拉同团队最近的沉淀草稿（status=draft，按时间倒序）
  const draftList = (await callEnvelope({
    ...hub,
    action: "asset/list",
    body: { team_id: teamId, status: "draft", limit: DRAFT_LIMIT },
  })) as { items: { id: string; title: string; source?: { origin?: string; session_id?: string } }[] };
  const draftItems = draftList.items ?? [];
  const draftContents: { title: string; content: string; session_id?: string }[] = [];
  for (const d of draftItems.slice(0, DRAFT_LIMIT)) {
    try {
      const det = (await callEnvelope({ ...hub, action: "asset/get", body: { asset_id: d.id } })) as {
        version: { content: string };
      };
      draftContents.push({
        title: d.title,
        content: det.version.content,
        ...(d.source?.session_id ? { session_id: d.source.session_id } : {}),
      });
    } catch {
      // 个别草稿读不到（权限/并发）不拦整个 reflect
    }
  }

  // 3) LLM 分析
  const prompt = buildReflectPrompt({
    assetTitle: detail.asset.title,
    assetContent: detail.version.content,
    drafts: draftContents,
  });
  const response = await chatCompletion(options, prompt.system, prompt.user);
  const proposals = parseReflectResponse(response);

  const report: ReflectReport = {
    ok: true,
    asset_id: detail.asset.id,
    asset_title: detail.asset.title,
    drafts_read: draftContents.length,
    proposals,
    submitted: { updates: 0, atoms: 0, review_ids: [] },
    errors: [],
  };

  if (options.dryRun === true) return report;

  // 4) 提交提议
  // 4a) 资产更新：走 asset/update（base_version → 人审裁决；Mgr 也走 review？看 review_mode）
  for (const update of proposals.asset_updates) {
    try {
      const out = (await callEnvelope({
        ...hub,
        action: "asset/update",
        body: {
          asset_id: detail.asset.id,
          base_version: detail.asset.current_version,
          title: update.title,
          content: update.content,
          change_note: `reflect: ${update.reason.slice(0, 200)}`,
        },
      })) as Record<string, unknown>;
      report.submitted.updates += 1;
      if (out["status"] === "pending_review" && typeof out["review_id"] === "string") {
        report.submitted.review_ids.push(out["review_id"]);
      }
    } catch (err) {
      report.errors.push(`asset/update: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // 4b) 新 atom：走 session/report（私有草稿 → 人审采纳）
  if (proposals.new_atoms.length > 0) {
    try {
      const out = (await callEnvelope({
        ...hub,
        action: "session/report",
        body: {
          team_id: teamId,
          session_id: `reflect-${Date.now()}`,
          candidates: proposals.new_atoms.map((a) => ({
            type: "memory",
            title: a.title,
            content: a.content,
            layer: "atom",
          })),
        },
      })) as { drafts: unknown[] };
      report.submitted.atoms = out.drafts.length;
    } catch (err) {
      report.errors.push(`session/report: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}

/**
 * `ck reflect --team <slug>`（P5，optimization-analysis §2.3）：对团队全部活跃资产跑 reflect。
 * 按「有草稿关联的资产优先」排序（草稿多的先跑），产出批量提议。
 * 每条资产的 reflect 与单资产模式同门（读资产+草稿 → LLM → 提议 → update 门 / 草稿）。
 */
export async function runReflectTeam(options: ReflectTeamOptions): Promise<{
  ok: boolean;
  team: string;
  assets_processed: number;
  reports: ReflectReport[];
  errors: string[];
}> {
  const hub = { hub: options.config.hub!, key: options.config.key!, timeoutMs: options.timeoutMs, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) };
  const limit = options.limit ?? 10;

  // 1) 拉团队全部活跃资产 + 全部草稿
  const [assets, drafts] = await Promise.all([
    callEnvelope({ ...hub, action: "asset/list", body: { team: options.team, status: "active", limit: 100 } }),
    callEnvelope({ ...hub, action: "asset/list", body: { team: options.team, status: "draft", limit: 100 } }),
  ]);
  const activeAssets = (assets as { items: { id: string; title: string; visibility: string }[] }).items ?? [];
  const draftItems = (drafts as { items: { id: string; title: string }[] }).items ?? [];

  if (activeAssets.length === 0) {
    return { ok: true, team: options.team, assets_processed: 0, reports: [], errors: [] };
  }

  // 2) 按「有草稿关联的资产优先」排序（简单启发：标题与草稿标题有交集的资产先跑）
  const draftTitles = new Set(draftItems.map((d) => d.title));
  const sorted = activeAssets.sort((a, b) => {
    const aHas = draftTitles.has(a.title) ? 1 : 0;
    const bHas = draftTitles.has(b.title) ? 1 : 0;
    return bHas - aHas || a.title.localeCompare(b.title);
  });
  const targets = sorted.slice(0, limit);

  // 3) 逐条跑 reflect（顺序执行，与批处理的节奏一致——单条失败不拦后续）
  const reports: ReflectReport[] = [];
  const errors: string[] = [];
  for (const asset of targets) {
    try {
      const report = await runReflect({
        config: options.config,
        url: options.url,
        model: options.model,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        assetId: asset.id,
        team: options.team,
        dryRun: options.dryRun === true,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      reports.push(report);
    } catch (err) {
      errors.push(`${asset.title} (${asset.id}): ${(err as Error).message.slice(0, 200)}`);
    }
  }

  return {
    ok: errors.length === 0 && reports.every((r) => r.ok),
    team: options.team,
    assets_processed: reports.length,
    reports,
    errors,
  };
}
