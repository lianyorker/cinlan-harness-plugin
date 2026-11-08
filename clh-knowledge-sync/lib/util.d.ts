export declare const nowIso: () => string;
export declare function sha256Hex(input: string): string;
/** 确定性 JSON 序列化：键递归排序，保证同内容同哈希。 */
export declare function stableStringify(value: unknown): string;
/** 对任意结构化内容做稳定哈希（内容寻址的基础）。 */
export declare function contentHash(value: unknown): string;
export declare function newId(prefix: string): string;
/**
 * 记忆条目的逻辑 id：由标题 slug 决定，与内容无关——
 * 同名条目在两节点间天然同 id，内容不同即产生可检测的同步冲突。
 */
export declare function slugify(title: string): string;
export declare const MEMORY_ID_PREFIX = "mem-";
export declare function memoryIdFor(title: string, explicitId?: string): string;
/** harness 的 skill-filesystem 要求 kebab-case 名称；错误名称在推送前就被拦下并报错。 */
export declare function validateSkillName(name: string): string | null;
export interface FrontmatterData {
    [key: string]: string | string[];
}
/** 解析 `--- ... ---` frontmatter（行式 key: value，支持 [a, b] 数组），无 frontmatter 返回 null。 */
export declare function parseFrontmatter(text: string): {
    data: FrontmatterData;
    body: string;
} | null;
export interface MemoryEntryInput {
    id: string;
    title: string;
    content: string;
    tags: string[];
    meta: Record<string, unknown>;
    expires?: string;
    updatedAt: string;
    hash: string;
    sourcePath?: string;
}
/** 把本地 md/JSON 条目折算成统一的哈希输入（标题+正文+标签+过期，不含文件路径）。 */
export declare function memoryHashOf(e: {
    title: string;
    content: string;
    tags?: string[];
    expires?: string;
}): string;
export declare function formatMemoryMarkdown(e: {
    id: string;
    title: string;
    content: string;
    tags: string[];
    meta?: Record<string, unknown>;
    expires?: string;
    updatedAt: string;
    hash?: string;
    version?: number;
    source?: string;
}): string;
export declare function ensureDir(dir: string): Promise<void>;
/** 原子写：同目录临时文件 + rename，避免读到半截文件。 */
export declare function atomicWriteFile(file: string, data: string | Buffer): Promise<void>;
export declare function writeJson(file: string, value: unknown): Promise<void>;
export declare function readJson<T>(file: string): Promise<T>;
export declare function pathExists(p: string): Promise<boolean>;
/** 受限删除：拒绝空串/根路径/结尾斜杠，防误删。 */
export declare function removePath(p: string): Promise<void>;
export interface WalkOptions {
    maxDepth?: number;
    /** 是否进入 . 开头目录（默认不进，.clh-knowledge-sync 状态目录因此不会被扫成内容） */
    includeDotDirs?: boolean;
}
/** 递归列出相对路径文件；默认深度 6、跳过 node_modules/.git 与 . 开头目录。 */
export declare function walkFiles(dir: string, opts?: WalkOptions): Promise<string[]>;
export declare function isTextFile(name: string): boolean;
export declare class SyncError extends Error {
    code: string;
    detail?: unknown;
    constructor(code: string, message: string, detail?: unknown);
}
