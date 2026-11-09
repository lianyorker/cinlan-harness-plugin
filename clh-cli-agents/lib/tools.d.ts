/**
 * @cinlan/clh-cli-agents/tools 插件行：向 harness 工具流水线注册两个模型可调用工具。
 * 依赖 ctx.tools（base profile 提供）与 ctx.clhCliAgents（主插件行提供）。
 * 工具把结构化结果渲染为模型可读文本；服务未就绪时给出明确错误，不静默。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RunResult } from './runtime.js';
export declare const name = "clh-cli-agents-tools";
export declare const inject: string[];
/** RunResult → 模型可读文本：状态行 + 截断的 stdout/stderr（超长时明确标注）。 */
export declare function renderRunResult(r: RunResult): string;
export declare function apply(ctx: Context): void;
