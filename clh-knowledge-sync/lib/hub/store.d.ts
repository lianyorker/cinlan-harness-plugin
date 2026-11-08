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
export interface PendingItem {
    queueId: string;
    kind: EntryKind;
    id: string;
    node: string;
    payload: PushPayload;
    receivedAt: string;
}
export interface RejectedItem {
    queueId: string;
    kind: EntryKind;
    id: string;
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
    seq: number;
    reason: string;
    at: string;
    by: string;
}
export interface PushResultItem {
    id: string;
    kind: EntryKind;
    status: 'queued' | 'duplicate' | 'pending-duplicate' | 'conflict' | 'invalid';
    queueId?: string;
    message?: string;
    serverVersion?: number;
    serverHash?: string;
}
export interface SearchHit {
    kind: EntryKind;
    id: string;
    title: string;
    description?: string;
    tags: string[];
    score: number;
    version: number;
    seq: number;
    snippet: string;
    updatedAt: string;
    sourceNode: string;
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
    pullSince(sinceSeq: number, kinds: EntryKind[]): {
        entries: PublishedEntry[];
        cursor: number;
        tombstones: Tombstone[];
    };
    getEntry(kind: EntryKind, id: string): PublishedEntry | undefined;
    searchPublished(query: string, kinds: EntryKind[], limit?: number): SearchHit[];
    cleanupScan(opts: {
        olderThanDays?: number;
        expiredOnly?: boolean;
    }): Array<{
        kind: EntryKind;
        id: string;
        title: string;
        reasons: string[];
        expires?: string;
        updatedAt: string;
    }>;
    cleanupPropose(targets: Array<{
        kind: EntryKind;
        id: string;
    }>, reason: string, admin: string): Promise<Array<{
        kind: EntryKind;
        id: string;
        status: string;
        message?: string;
    }>>;
    listFlagged(): PublishedEntry[];
    cleanupDecide(targets: Array<{
        kind: EntryKind;
        id: string;
    }>, action: 'approve' | 'reject', admin: string, reason: string): Promise<Array<{
        kind: EntryKind;
        id: string;
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
            fileHash: string;
            contentHash: string;
        }>;
    }>;
}
