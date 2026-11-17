import type { ErrorCode } from "@cinlan/knowledge-sdk";
import type { McpContext } from "./types.js";

/**
 * 客户端自己产生的固定文本只在这里：brief 引导语、读档失败提示、缓存提示。
 * 三者都不含资产内容；资产文本一律由 hub 的 `loadout/resolve` 生成（D-17、D-23）。
 */

export const BRIEF_MAX_CHARS = 1500;

export const INSTRUCTIONS_MAX_CHARS = 12000;
export const INSTRUCTIONS_MAX_BYTES = 24000;

/** `brief`（≤ 1,500 字符）放 MCP `instructions`；Claude Code 的 hook 后手也用它。 */
export function briefInstructions(ctx: McpContext): string {
  const team = ctx.team_name ?? ctx.team_id;
  const agent = ctx.agent_name ?? ctx.agent_id;
  const attrs = `${team ? ` team="${team}"` : ""}${agent ? ` agent="${agent}"` : ""}`;
  return [
    `<cinlan_knowledge_brief${attrs}>`,
    "本会话接入了团队记忆中枢（MCP server：ck）。",
    "- 上下文里没有 <cinlan_knowledge> 块时，先调用 knowledge_status（reload: true）读取团队配装。",
    "- 涉及团队约定、流程、历史结论时，先 knowledge_search，再用 knowledge_open 取全文。",
    "- 值得留存的结论用 knowledge_save（默认仅自己可见）；要给团队用，再 knowledge_share。",
    "- 会话收尾时把值得留存的候选交给 knowledge_session_report（落草稿收件箱，由人采纳）。",
    "</cinlan_knowledge_brief>",
  ].join("\n");
}

/** 读档失败时代替配装文本：写明错误枚举，让模型自己调 knowledge_status 查明原因。 */
export function errorInstructions(code: ErrorCode): string {
  return [
    `<cinlan_knowledge error="${code}">`,
    `团队记忆中枢本次读档失败：${code}。团队配装未加载；调用 knowledge_status 查看原因。`,
    "</cinlan_knowledge>",
  ].join("\n");
}

/** 用缓存兜底时加在原样输出的缓存文本之前；字面量见 loadout.md §3，`ck mcp` 与 `ck hook` 共用。 */
export function cachedNotice(fetchedAt: string): string {
  return `<cinlan_knowledge_notice stale="true" fetched_at="${fetchedAt}">hub 暂不可达，以下配装来自本机缓存。</cinlan_knowledge_notice>`;
}

/** 不截断：超过任一上限就整段退回 brief，并提示重读（loadout.md §7.4）。 */
export function fitInstructions(text: string, ctx: McpContext): string {
  const chars = text.length;
  const bytes = Buffer.byteLength(text, "utf8");
  if (chars > INSTRUCTIONS_MAX_CHARS || bytes > INSTRUCTIONS_MAX_BYTES) {
    return briefInstructions(ctx);
  }
  return text;
}
