/**
 * @cinlan/clh-cli-agents 主插件行。
 *
 * 提供 ctx.clhCliAgents 服务（list/detect/run/state）并在启动时可选探测全部 agent。
 * 运行时（子进程、并发信号量）随插件 fiber 卸载一并清理（ctx.effect → runtime.dispose）。
 * 参考：stablyai/orca 的声明式 agent 目录 + deepseek-harness 实验包的钩子桥思路
 * （外部工具生态接入 harness 扩展点），本插件把「外部 CLI agent」变成 harness 可派发的执行资源。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { buildConfigSchema, type CliAgentsConfigInput, type ResolvedAgent } from './config.js';
import { type DetectResult, type RunOptions, type RunResult } from './runtime.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        clhCliAgents: clhCliAgentsService;
    }
}
export declare const name = "clh-cli-agents";
export declare const Config: ReturnType<typeof buildConfigSchema>;
/** loader 以模块整体为插件：先经 Config 校验，再挂 Service 类（constructor 收到校验后的 config）。 */
export declare function apply(ctx: Context, config: CliAgentsConfigInput): void;
export declare class clhCliAgentsService extends Service {
    private resolved;
    private logger;
    private runtime;
    /** 探测结果缓存（detectOnStart 时填充；detectAll 默认读缓存，refresh 时重跑） */
    private detectCache;
    constructor(ctx: Context, config: CliAgentsConfigInput | undefined);
    private configure;
    protected [Service.init](): Promise<void>;
    get agentIds(): string[];
    list(): ResolvedAgent[];
    detect(id: string, refresh?: boolean): Promise<DetectResult>;
    detectAll(refresh?: boolean): Promise<DetectResult[]>;
    run(id: string, prompt: string, options?: RunOptions): Promise<RunResult>;
    state(): unknown;
}
