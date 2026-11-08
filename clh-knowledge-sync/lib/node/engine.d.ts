import type { ResolvedNodeConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { EntryKind, PushResultItem } from '../hub/store.js';
import { HubClient } from './http-client.js';
import { LocalStore } from './local-store.js';
export interface PushedRecord {
    kind: EntryKind;
    hash: string;
    queueId?: string;
    status: 'pending' | 'approved' | 'rejected' | 'conflict' | 'published-duplicate' | 'invalid';
    reason?: string;
    version?: number;
    seq?: number;
    at: string;
}
export interface SyncState {
    version: 1;
    cursor: number;
    pushed: Record<string, PushedRecord>;
    conflicts: Array<{
        ts: string;
        direction: 'push' | 'pull';
        kind: EntryKind;
        id: string;
        detail: string;
    }>;
    lastError?: {
        at: string;
        code: string;
        message: string;
        operation: string;
    };
    lastSyncAt?: string;
    lastPullAt?: string;
}
export interface CycleResult {
    operation: 'push' | 'status' | 'pull';
    ok: boolean;
    counts: Record<string, number>;
    errors?: Array<{
        code: string;
        message: string;
    }>;
}
export declare class SyncEngine {
    private readonly cfg;
    private readonly client;
    private readonly local;
    private readonly logger;
    private state;
    private timer;
    private running;
    constructor(cfg: ResolvedNodeConfig, client: HubClient, local: LocalStore, logger: Logger);
    loadState(): Promise<void>;
    private saveState;
    stateSnapshot(): SyncState & {
        hub: string;
        node: string;
    };
    private recordError;
    pushCycle(force?: boolean, kindFilter?: EntryKind): Promise<CycleResult & {
        details?: PushResultItem[];
    }>;
    private hashOf;
    statusCycle(): Promise<CycleResult & {
        statuses?: Array<Record<string, unknown>>;
    }>;
    pullCycle(kindFilter?: EntryKind): Promise<CycleResult & {
        details?: Array<Record<string, unknown>>;
    }>;
    private findLocalMemory;
    search(query: string, limit?: number): Promise<{
        query: string;
        total: number;
        results: Array<Record<string, unknown>>;
    }>;
    doctor(): Promise<{
        ok: boolean;
        hub: string;
        detail?: unknown;
        error?: {
            code: string;
            message: string;
        };
    }>;
    startAuto(): void;
    stopAuto(): void;
    runCycle(): Promise<void>;
    oneshot(commands: string[], resultFile: string): Promise<{
        ok: boolean;
        results: Array<Record<string, unknown>>;
    }>;
}
