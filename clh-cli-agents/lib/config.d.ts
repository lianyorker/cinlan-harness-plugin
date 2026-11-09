/**
 * @cinlan/clh-cli-agents 配置层。
 *
 * 参照 stablyai/orca 的 TUI_AGENT_CONFIG：每个外部 CLI agent 用一条声明式条目描述
 * （探测命令、启动命令、prompt 注入方式、并发上限），插件本体不写死任何 agent——
 * 新增 claude / codex / orca 等只改配置，不改代码。
 *
 * 校验规则：一次性列出全部问题再抛 ConfigError（不静默失败、不逐个试错）；
 * resolveConfig 不经过 Schemastery 也能工作（CLI 从 JSON 文件读配置走同一条路）。
 */
import Schema from '@deepseek-ai/schemastery';
import type { LogLevel } from './logger.js';
export declare const PROMPT_INJECTION_MODES: readonly ['argv', 'flag-prompt', 'stdin-after-start'];
export type PromptInjectionMode = (typeof PROMPT_INJECTION_MODES)[number];
/**
 * exec = 一次性 headless 运行（注入 prompt → 收集输出 → 结构化返回）。
 * acp 是给后续 orca / claude-code-acp 这类 JSON-RPC stdio agent 预留的协议位：
 * schema 放行、resolveConfig 明确报「未实现」，避免将来加协议时改配置结构。
 */
export declare const PROTOCOLS: readonly ['exec'];
export type Protocol = (typeof PROTOCOLS)[number];
export declare const RESERVED_PROTOCOLS: readonly ['acp'];
export type OutputFormat = 'text' | 'json';
export interface AgentConfigInput {
    command?: unknown;
    args?: unknown;
    detect?: unknown;
    promptInjectionMode?: unknown;
    promptFlag?: unknown;
    argvSeparator?: unknown;
    cwd?: unknown;
    env?: unknown;
    timeoutMs?: unknown;
    outputFormat?: unknown;
    maxConcurrent?: unknown;
    protocol?: unknown;
    description?: unknown;
}
export interface CliAgentsConfigInput {
    agents?: Record<string, AgentConfigInput>;
    detectOnStart?: unknown;
    log?: {
        level?: unknown;
        dir?: unknown;
    };
}
export interface ResolvedAgent {
    id: string;
    /** 原始命令名（PATH 解析在 runtime 做，保持 run/detect 行为一致） */
    command: string;
    args: string[];
    /** 探测命令；缺省 = `${command} --version` */
    detect: string;
    promptInjectionMode: PromptInjectionMode;
    promptFlag?: string;
    argvSeparator?: string;
    /** 已按插件启动目录解析为绝对路径 */
    cwd?: string;
    env: Record<string, string>;
    timeoutMs: number;
    outputFormat: OutputFormat;
    maxConcurrent: number;
    protocol: Protocol;
    description: string;
}
export interface ResolvedConfig {
    agents: Map<string, ResolvedAgent>;
    detectOnStart: boolean;
    logLevel: LogLevel;
    logDir?: string;
}
export declare class ConfigError extends Error {
    readonly problems: string[];
    constructor(problems: string[]);
}
export declare class CliAgentError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 解析并校验整份配置；有问题全部收集后一次抛出。 */
export declare function resolveConfig(raw: CliAgentsConfigInput, baseDir: string): ResolvedConfig;
/** Schemastery schema：settings 面与 loader 校验用；运行时语义以 resolveConfig 为准。 */
export declare function buildConfigSchema(S: typeof Schema): Schema<Schemastery.ObjectS<NoInfer<{
    agents: Schema<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        detect?: string | null | undefined;
        promptInjectionMode?: "argv" | "flag-prompt" | "stdin-after-start" | null | undefined;
        promptFlag?: string | null | undefined;
        argvSeparator?: string | null | undefined;
        cwd?: string | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        timeoutMs?: number | null | undefined;
        outputFormat?: "json" | "text" | null | undefined;
        maxConcurrent?: number | null | undefined;
        protocol?: "acp" | "exec" | null | undefined;
        description?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<NoInfer<{
        command: Schema<string, string, "defined">;
        args: Schema<string[], string[], "plain">;
        detect: Schema<string, string, "plain">;
        promptInjectionMode: Schema<"argv" | "flag-prompt" | "stdin-after-start", "argv" | "flag-prompt" | "stdin-after-start", "plain">;
        promptFlag: Schema<string, string, "plain">;
        argvSeparator: Schema<string, string, "plain">;
        cwd: Schema<string, string, "plain">;
        env: Schema<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "plain">;
        timeoutMs: Schema<number, number, "plain">;
        outputFormat: Schema<"json" | "text", "json" | "text", "plain">;
        maxConcurrent: Schema<number, number, "plain">;
        protocol: Schema<"acp" | "exec", "acp" | "exec", "plain">;
        description: Schema<string, string, "plain">;
    }>>, string>, "plain">;
    detectOnStart: Schema<boolean, boolean, "plain">;
    log: Schema<Schemastery.ObjectS<NoInfer<{
        level: Schema<"debug" | "error" | "info" | "warn", "debug" | "error" | "info" | "warn", "plain">;
        dir: Schema<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        level: Schema<"debug" | "error" | "info" | "warn", "debug" | "error" | "info" | "warn", "plain">;
        dir: Schema<string, string, "plain">;
    }>>, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    agents: Schema<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        detect?: string | null | undefined;
        promptInjectionMode?: "argv" | "flag-prompt" | "stdin-after-start" | null | undefined;
        promptFlag?: string | null | undefined;
        argvSeparator?: string | null | undefined;
        cwd?: string | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        timeoutMs?: number | null | undefined;
        outputFormat?: "json" | "text" | null | undefined;
        maxConcurrent?: number | null | undefined;
        protocol?: "acp" | "exec" | null | undefined;
        description?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<NoInfer<{
        command: Schema<string, string, "defined">;
        args: Schema<string[], string[], "plain">;
        detect: Schema<string, string, "plain">;
        promptInjectionMode: Schema<"argv" | "flag-prompt" | "stdin-after-start", "argv" | "flag-prompt" | "stdin-after-start", "plain">;
        promptFlag: Schema<string, string, "plain">;
        argvSeparator: Schema<string, string, "plain">;
        cwd: Schema<string, string, "plain">;
        env: Schema<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>, "plain">;
        timeoutMs: Schema<number, number, "plain">;
        outputFormat: Schema<"json" | "text", "json" | "text", "plain">;
        maxConcurrent: Schema<number, number, "plain">;
        protocol: Schema<"acp" | "exec", "acp" | "exec", "plain">;
        description: Schema<string, string, "plain">;
    }>>, string>, "plain">;
    detectOnStart: Schema<boolean, boolean, "plain">;
    log: Schema<Schemastery.ObjectS<NoInfer<{
        level: Schema<"debug" | "error" | "info" | "warn", "debug" | "error" | "info" | "warn", "plain">;
        dir: Schema<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        level: Schema<"debug" | "error" | "info" | "warn", "debug" | "error" | "info" | "warn", "plain">;
        dir: Schema<string, string, "plain">;
    }>>, "plain">;
}>>, "plain">;
