import type { Logger } from '../logger.js';
export type EntryKind = 'memory' | 'skill';
export interface SkillFilePayload {
    path: string;
    encoding: 'utf8' | 'base64';
    content: string;
}
export interface PushPayload {
    kind: EntryKind;
    id: string;
    /** 目标作用域：""=全局、proj:<p>、proj:<p>:mod:<m>；缺省视为全局。 */
    scope?: string;
    title?: string;
    description?: string;
    content?: string;
    files?: SkillFilePayload[];
    tags?: string[];
    meta?: Record<string, unknown>;
    expires?: string;
    hash: string;
    updatedAt?: string;
    baseVersion?: number;
    force?: boolean;
}
export interface PublishedEntry {
    kind: EntryKind;
    id: string;
    /** 所属作用域；旧数据文件迁移加载时补 ""。 */
    scope: string;
    title: string;
    description?: string;
    content?: string;
    files?: SkillFilePayload[];
    tags: string[];
    meta: Record<string, unknown>;
    expires?: string;
    hash: string;
    version: number;
    seq: number;
    sourceNode: string;
    updatedAt: string;
    approvedBy: string;
    approvedAt: string;
    cleanupFlag?: {
        proposedAt: string;
        reason: string;
        by: string;
    } | null;
}
/** 总库列表项：listEntries 的输出，刻意不含 content/files 正文。 */
export interface PublishedEntrySummary {
    kind: EntryKind;
    id: string;
    scope: string;
    title: string;
    description?: string;
    tags: string[];
    version: number;
    seq: number;
    sourceNode: string;
    updatedAt: string;
    expires?: string;
    cleanupFlag?: {
        proposedAt: string;
        reason: string;
        by: string;
    } | null;
}
export interface PendingItem {
    queueId: string;
    kind: EntryKind;
    id: string;
    /** 镜像 payload.scope，供列表/审批直接展示（旧数据加载时回填）。 */
    scope: string;
    node: string;
    payload: PushPayload;
    receivedAt: string;
}
export interface RejectedItem {
    queueId: string;
    kind: EntryKind;
    id: string;
    scope: string;
    node: string;
    payload: PushPayload;
    receivedAt: string;
    decidedAt: string;
    decidedBy: string;
    reason: string;
}
export interface Tombstone {
    kind: EntryKind;
    id: string;
    scope: string;
    seq: number;
    reason: string;
    at: string;
    by: string;
}
export interface PushResultItem {
    id: string;
    kind: EntryKind;
    scope?: string;
    status: 'queued' | 'duplicate' | 'pending-duplicate' | 'conflict' | 'invalid';
    queueId?: string;
    message?: string;
    serverVersion?: number;
    serverHash?: string;
}
export interface SearchHit {
    kind: EntryKind;
    id: string;
    scope: string;
    title: string;
    description?: string;
    tags: string[];
    score: number;
    version: number;
    seq: number;
    snippet: string;
    /** 预估 token（粗略 len/3，CJK 偏重偏保守；给调用方做 context 预算用） */
    estTokens: number;
    /** 仅带 budget 的检索返回正文：命中即「可直接灌 context」 */
    content?: string;
    updatedAt: string;
    sourceNode: string;
    expires?: string;
}
export interface StoreStats {
    published: {
        memory: number;
        skill: number;
    };
    pending: number;
    rejected: number;
    archived: number;
    flagged: number;
    tombstones: number;
    seq: number;
    corruptFiles: number;
}
export declare class HubStore {
    private readonly dataDir;
    private readonly logger;
    private readonly limits;
    private published;
    private pending;
    private rejected;
    private approvals;
    private tombstones;
    private seq;
    private corruptFiles;
    private archivedCount;
    constructor(dataDir: string, logger: Logger, limits: {
        maxFileBytes: number;
        maxItemsPerPush: number;
    });
    private dirFor;
    private auditFile;
    private audit;
    /** 启动时从磁盘恢复全部状态；损坏文件计入 corruptFiles 并在 stats 中暴露，不静默丢弃。 */
    load(): Promise<void>;
    private persistSeq;
    private persistApprovals;
    validatePayload(payload: PushPayload): string | null;
    enqueuePush(node: string, payload: PushPayload): Promise<PushResultItem>;
    listPending(): PendingItem[];
    listRejected(): RejectedItem[];
    decide(queueId: string, action: 'approve' | 'reject', admin: string, reason: string): Promise<Record<string, unknown>>;
    /** 节点回读自己推送的审批结果。 */
    pushStatus(queueIds: string[]): Array<Record<string, unknown>>;
    /**
     * readScopes：grant-like 可见性集（服务端已做过 授权∩请求 求交，可含通配）。
     * undefined = 不过滤（hub 内部/管理员路径）；[] = 全不可见。
     */
    pullSince(sinceSeq: number, kinds: EntryKind[], readScopes?: string[]): {
        entries: PublishedEntry[];
        cursor: number;
        tombstones: Tombstone[];
    };
    getEntry(kind: EntryKind, id: string, scope?: string): PublishedEntry | undefined;
    /**
     * 总库轻量列表（管理面板浏览用）：不带 content/files 正文。
     * q 可选：对 id/title/description/tags 做不区分大小写的包含过滤（非打分检索）。
     */
    listEntries(opts?: {
        kinds?: EntryKind[];
        q?: string;
        scope?: string;
    }): PublishedEntrySummary[];
    /**
     * 检索已发布条目。opts.budget 为 token 预算：按打分排序后累计 estTokens 填满为止
     * （第一条哪怕超预算也放行，保证非空）；带 budget 时命中附 content 全文，
     * 供调用方直接塞进 context（hindsight recall 的 token-budget 语义）。
     * since/before（ms）对 updatedAt 过滤；expiredOnly 只回已过期条目。
     */
    searchPublished(query: string, kinds: EntryKind[], limit?: number, readScopes?: string[], opts?: {
        budget?: number;
        since?: number;
        before?: number;
        expiredOnly?: boolean;
    }): SearchHit[];
    cleanupScan(opts: {
        olderThanDays?: number;
        expiredOnly?: boolean;
    }): Array<{
        kind: EntryKind;
        id: string;
        scope: string;
        title: string;
        reasons: string[];
        expires?: string;
        updatedAt: string;
    }>;
    cleanupPropose(targets: Array<{
        kind: EntryKind;
        id: string;
        scope?: string;
    }>, reason: string, admin: string): Promise<Array<{
        kind: EntryKind;
        id: string;
        scope?: string;
        status: string;
        message?: string;
    }>>;
    listFlagged(): PublishedEntry[];
    cleanupDecide(targets: Array<{
        kind: EntryKind;
        id: string;
        scope?: string;
    }>, action: 'approve' | 'reject', admin: string, reason: string): Promise<Array<{
        kind: EntryKind;
        id: string;
        scope?: string;
        status: string;
        message?: string;
    }>>;
    stats(): StoreStats;
    /** 自检：published 内容哈希应与内容一致，暴露静默篡改/损坏。 */
    integrityCheck(): Promise<{
        checked: number;
        mismatched: Array<{
            kind: EntryKind;
            id: string;
            scope: string;
            fileHash: string;
            contentHash: string;
        }>;
    }>;
}
