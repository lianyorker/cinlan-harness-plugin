/**
 * @cinlan/clh-knowledge-sync/tools 插件行：向 harness 工具流水线注册四个模型可调用工具。
 * 依赖 ctx.tools（base profile 提供）与 ctx.clhKnowledgeSync（主插件行提供）。
 * 工具把结构化结果渲染为模型可读文本；服务未就绪时给出明确错误，不静默。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "clh-knowledge-sync-tools";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
