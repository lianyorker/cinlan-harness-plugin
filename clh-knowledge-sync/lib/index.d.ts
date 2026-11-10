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
    search(query: string, limit?: number, opts?: SearchOpts): Promise<unknown>;
    status(): Promise<unknown>;
    doctor(): Promise<unknown>;
    state(): unknown;
}
/** 检索过滤参数：budget=token 预算截断（命中附正文）；since/before=ISO 时间过滤 updatedAt；expiredOnly=只看已过期 */
export interface SearchOpts {
    budget?: number;
    since?: string;
    before?: string;
    expiredOnly?: boolean;
}
export declare class clhKnowledgeSyncService extends Service {
    private resolved;
    private logger;
    private client;
    private local;
    private engine;
    private initialized;
    /**
     * Typert Gateway 绑定：等价于 typert-protocol 的 bindTypertRemote 产物
     * （本插件不依赖该包，手工构造同形 frozen 对象）。api/gateway 的 SRC 发现
     * 靠它把 clhKnowledgeSync/* 端点认领进 /api RPC；仅 owner Peer 可调
     * （无 resources 声明的方法对非 owner 一律 deny）。
     */
    readonly typertRemote: {
        readonly service: object;
        readonly serviceKey: string;
        readonly namespace: string;
    };
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
    search(query: string, limit?: number, opts?: SearchOpts): Promise<unknown>;
    status(): Promise<unknown>;
    doctor(): Promise<unknown>;
    state(): unknown;
    /** 待审批队列。 */
    adminPending(): Promise<unknown>;
    /** 已拒绝队列。 */
    adminRejected(): Promise<unknown>;
    /** 审批决定。action = 'approve' | 'reject'；reject 必填 reason。 */
    adminDecide(queueId: string, action: string, reason: string): Promise<unknown>;
    /** 总库轻量列表；kinds 传 'memory,skill' 的逗号串或空串，q 为包含过滤，scope 精确过滤（'' 或 '*' = 全部）。 */
    adminEntries(kinds: string, q: string, scope: string): Promise<unknown>;
    /** 总库单条详情（含正文/文件）；scope 缺省为全局 ''——同 id 跨 scope 时必须传。 */
    adminEntry(kind: string, id: string, scope: string): Promise<unknown>;
    /** 存储统计。 */
    adminStats(): Promise<unknown>;
}
