import { type ResolvedAgent, type ResolvedConfig } from './config.js';
import type { Logger } from './logger.js';
export interface DetectResult {
    agent: string;
    installed: boolean;
    version?: string;
    exitCode?: number | null;
    error?: string;
    durationMs: number;
}
export interface RunResult {
    agent: string;
    ok: boolean;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    /** outputFormat=json 时从 stdout 解析出的值 */
    parsed?: unknown;
    parseFailed?: boolean;
    /** 实际 argv（含 prompt 原文，审计/复现用） */
    argv: string[];
    cwd: string;
    error?: string;
}
export interface RunOptions {
    cwd?: string;
    timeoutMs?: number;
}
/** PATH 解析（Windows 遵循 PATHEXT 的 .com/.exe；.bat/.cmd 拒绝，见文件头说明）。 */
export declare function resolveCommand(command: string): string;
/** 按 orca 语义把 prompt 组进 argv；stdin-after-start 返回不带 prompt 的 argv。 */
export declare function buildArgv(agent: ResolvedAgent, prompt: string): string[];
/** 从 stdout 提取 JSON 值：整体解析失败则取第一个 {/[ 到最后一个 }/] 的子串再试。 */
export declare function extractJson(text: string): {
    value?: unknown;
    failed?: boolean;
};
export declare class AgentRuntime {
    private readonly config;
    private readonly logger;
    private readonly semaphores;
    private readonly running;
    private disposed;
    constructor(config: ResolvedConfig, logger: Logger);
    list(): ResolvedAgent[];
    get(id: string): ResolvedAgent | undefined;
    runningCount(): number;
    private semaphoreFor;
    /** 探测 agent 是否在位：跑 detect 命令（配置受信，走 shell；prompt 不经此路径）。 */
    detect(id: string): Promise<DetectResult>;
    /**
     * 探测专用收集器：整条命令行走 shell（detect 是配置里的受信串，可能含路径与参数），
     * 与 run 的无 shell spawn 分离——prompt 永远不经此路径。
     */
    private spawnAndCollect;
    /** 派任务给 agent：注入 prompt → headless 运行 → 结构化结果。同 agent 并发受 maxConcurrent 限制。 */
    run(id: string, prompt: string, options?: RunOptions): Promise<RunResult>;
    private runAgent;
    private waitForClose;
    /** 释放：终止全部运行中子进程并等待落定（服务 fiber 卸载时调用）。 */
    dispose(): Promise<void>;
}
