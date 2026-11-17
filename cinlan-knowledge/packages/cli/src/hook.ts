import { briefInstructions, cachedNotice, errorInstructions } from "@cinlan/knowledge-mcp";
import { PrepareError, contextOf, prepare, type AgentSpec, type PreparedLoadout } from "./prepare.js";
import type { ResolvedConfig } from "./config.js";

/**
 * `ck hook session-start`：把配装文本转成宿主格式的 JSON 写到 stdout。
 * 约定（loadout.md §4）：
 * - 永远以 0 退出，不拖垮宿主会话；
 * - 不截断：编码后的 JSON 超过 hook 预算就整段改投 brief + 提示重读；
 * - 失败时输出错误提示块；
 * - stdout 只有协议 JSON，日志走 stderr。
 *
 * 输出形状（hosts.md §4.3 / §4.6）：
 * - `claude-code`：`hookSpecificOutput.additionalContext`（session-start）；
 * - `hermes-context`：`{"context": ...}`（pre_llm_call，拼进 user 消息）。
 * `reloadSkills` 的字段位置在 S2 实机确认前不写（loadout.md §7 的"未验证"约定）。
 */

export interface HookOptions {
  config: ResolvedConfig;
  agent: AgentSpec;
  host: string;
  budgetChars: number;
  /** 输出形状；缺省 claude-code。 */
  output?: "claude-code" | "hermes-context";
  home?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HookOutput {
  exitCode: 0;
  json: Record<string, unknown>;
  /** 读档成功时的解析结果；失败为 null。`cmdHook` 拿它做 skill 物化（loadout.md §6 步骤 5）。 */
  prepared: PreparedLoadout | null;
}

/** 按宿主形状包裹注入文本；cmdHook 的失败兑底也用同一个函数，形状不能分叉。 */
export function wrapHookContext(
  text: string,
  output: "claude-code" | "hermes-context" = "claude-code",
): Record<string, unknown> {
  if (output === "hermes-context") return { context: text };
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

export async function runHook(options: HookOptions): Promise<HookOutput> {
  let prepared;
  try {
    prepared = await prepare({
      config: options.config,
      agent: options.agent,
      host: options.host,
      baseline: "full",
      home: options.home,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      budgetChars: options.budgetChars,
    });
  } catch (err) {
    const code = err instanceof PrepareError ? err.code : "INTERNAL";
    return { exitCode: 0, json: wrapHookContext(errorInstructions(code as Parameters<typeof errorInstructions>[0]), options.output), prepared: null };
  }

  const ctx = contextOf(prepared);
  // 预算按"编码后的 JSON"算：JSON 转义与外壳会让输出比文本长（loadout.md §4）。
  const withText = (text: string): Record<string, unknown> => wrapHookContext(text, options.output);
  let text = prepared.text;
  if (prepared.stale) text = `${cachedNotice(prepared.fetched_at)}\n${text}`;
  if (JSON.stringify(withText(text)).length > options.budgetChars) {
    text = `${briefInstructions(ctx)}\n请调用 knowledge_status（reload: true）读取团队配装。`;
  }
  return { exitCode: 0, json: withText(text), prepared };
}
