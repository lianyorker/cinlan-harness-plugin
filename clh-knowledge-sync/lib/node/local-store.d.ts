import type { ResolvedNodeConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { MemoryEntryInput } from '../util.js';
export interface LocalMemoryItem extends MemoryEntryInput {
}
export interface LocalSkillBundle {
    name: string;
    description: string;
    files: Array<{
        path: string;
        encoding: 'utf8' | 'base64';
        content: string;
    }>;
    hash: string;
    rootDir: string;
}
export interface RemoteMemoryEntry {
    kind: 'memory';
    id: string;
    title: string;
    content?: string;
    tags: string[];
    meta: Record<string, unknown>;
    expires?: string;
    hash: string;
    version: number;
    seq: number;
    sourceNode: string;
    updatedAt: string;
}
export interface RemoteSkillEntry {
    kind: 'skill';
    id: string;
    title: string;
    description?: string;
    files?: Array<{
        path: string;
        encoding: 'utf8' | 'base64';
        content: string;
    }>;
    tags: string[];
    hash: string;
    version: number;
    seq: number;
    sourceNode: string;
    updatedAt: string;
}
export type RemoteEntry = RemoteMemoryEntry | RemoteSkillEntry;
export declare class LocalStore {
    private readonly cfg;
    private readonly logger;
    constructor(cfg: ResolvedNodeConfig, logger: Logger);
    /** 扫描本地记忆（*.md + entries/*.json，跳过 shared/ 与状态目录）。 */
    scanMemory(): Promise<LocalMemoryItem[]>;
    writeSharedMemory(entry: RemoteMemoryEntry): Promise<string>;
    removeSharedMemory(id: string): Promise<boolean>;
    writeConflictMemory(entry: RemoteMemoryEntry): Promise<string>;
    scanSkillRoot(root: string): Promise<LocalSkillBundle[]>;
    scanSkills(): Promise<LocalSkillBundle[]>;
    private readBundle;
    /**
     * 把远端 skill bundle 写入指定根目录。
     * 返回 written（新写入/覆盖）/ unchanged（哈希相同）/ conflict-copy（本地冲突副本已保全）。
     */
    writeSkillBundle(root: string, entry: RemoteSkillEntry, opts?: {
        force?: boolean;
    }): Promise<{
        status: 'written' | 'unchanged' | 'conflict-copy';
        localBackup?: string;
        dir: string;
    }>;
    private writeBundleDir;
    /** 删除本插件拉取的 skill（有来源标记才删；本地手写不动，只告警）。 */
    removeSyncedSkill(root: string, name: string): Promise<'removed' | 'kept-local' | 'not-found'>;
    private copyTree;
}
