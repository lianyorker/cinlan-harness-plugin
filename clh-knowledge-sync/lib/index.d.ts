/**
 * @cinlan/clh-knowledge-sync 主插件行。
 *
 * 提供 ctx.clhKnowledgeSync 服务（push/pull/search/status/doctor + 状态快照），
 * 并按配置启动：oneshot 模式（跑完指定指令落结果文件后退出）或
 * 常驻模式（syncOnStart 首轮同步 + auto 定时循环）。
 * 定时器与日志随插件 fiber 卸载一并清理（ctx.effect）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { buildConfigSchema, type NodeSyncConfig } from './config.js';
import type { EntryKind } from './hub/store.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        clhKnowledgeSync: clhKnowledgeSyncService;
    }
}
export declare const name = "clh-knowledge-sync";
export declare const Config: ReturnType<typeof buildConfigSchema>;
/** loader 以模块整体为插件：先经 Config 校验，再挂 Service 类（constructor 收到校验后的 config）。 */
export declare function apply(ctx: Context, config: NodeSyncConfig): void;
export interface SyncServiceApi {
    nodeId: string;
    hub: string;
    push(force?: boolean, kind?: EntryKind): Promise<unknown>;
    pull(kind?: EntryKind): Promise<unknown>;
    search(query: string, limit?: number): Promise<unknown>;
    status(): Promise<unknown>;
    doctor(): Promise<unknown>;
    state(): unknown;
}
export declare class clhKnowledgeSyncService extends Service {
    private resolved;
    private logger;
    private client;
    private local;
    private engine;
    private initialized;
    constructor(ctx: Context, config: NodeSyncConfig | undefined);
    /** 停旧运行时并按新配置重建 client/local/engine；已初始化时恢复同步循环。 */
    private applyUpdate;
    /** 按已解析配置重建运行时对象（logger/client/local/engine）。 */
    private configure;
    protected [Service.init](): Promise<void>;
    private stopRuntime;
    get nodeId(): string;
    get hub(): string;
    push(force?: boolean, kind?: EntryKind): Promise<unknown>;
    pull(kind?: EntryKind): Promise<unknown>;
    search(query: string, limit?: number): Promise<unknown>;
    status(): Promise<unknown>;
    doctor(): Promise<unknown>;
    state(): unknown;
}
