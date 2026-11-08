type AnySchema = any;
interface HubProfileConfig {
    protocol: string;
    host: string;
    port?: number;
    basePath?: string;
    timeoutMs?: number;
    token?: string;
    tls?: {
        rejectUnauthorized?: boolean;
        caFile?: string;
    };
}
export interface NodeSyncConfig {
    node: {
        id: string;
        token: string;
    };
    hub: {
        activeProfile: string;
        profiles: Record<string, HubProfileConfig | undefined>;
    };
    sync: {
        auto: boolean;
        intervalSec: number;
        syncOnStart: boolean;
        memoryDir: string;
        skillRoots: string[];
        stateDirName: string;
    };
    oneshot: {
        enabled: boolean;
        commands: string[];
        resultFile: string;
    };
    log: {
        level: string;
        dir: string;
    };
}
/** 由 schemastery 校验后的插件配置（结构同 NodeSyncConfig，字段可能带默认值）。 */
export declare function buildConfigSchema(Schema: AnySchema): AnySchema;
export interface ResolvedProfile {
    name: string;
    protocol: 'http' | 'https';
    host: string;
    port: number;
    basePath: string;
    timeoutMs: number;
    token: string;
    rejectUnauthorized: boolean;
    caFile?: string;
}
export interface ResolvedNodeConfig {
    nodeId: string;
    token: string;
    profile: ResolvedProfile;
    auto: boolean;
    intervalSec: number;
    syncOnStart: boolean;
    memoryDir: string;
    skillRoots: string[];
    stateDir: string;
    logLevel: string;
    logDir: string;
    oneshot: {
        enabled: boolean;
        commands: string[];
        resultFile: string;
    };
}
/**
 * 归并插件原始配置为运行时配置。
 * schema 已保证必填项存在；这里负责解析激活 profile、补默认端口、路径绝对化，
 * 并在引用不存在的 profile 或 token 为空时给出能直接定位问题的错误。
 */
export declare function resolveNodeConfig(raw: NodeSyncConfig, cwd?: string): ResolvedNodeConfig;
export interface HubListenConfig {
    protocol: 'http' | 'https';
    host: string;
    port: number;
    tls?: {
        certFile?: string;
        keyFile?: string;
    };
}
export interface HubConfig {
    listen: HubListenConfig;
    auth: {
        adminToken: string;
        nodeTokens: Record<string, string>;
    };
    dataDir: string;
    limits: {
        maxBodyBytes: number;
        maxFileBytes: number;
        maxItemsPerPush: number;
    };
    log: {
        level: string;
        dir: string;
    };
}
/** 展开 "${ENV_NAME}" 占位符；缺失的环境变量直接报错，不静默替换为空。 */
export declare function interpolateEnv(text: string, label: string): string;
/** 读取并校验 hub 配置；任何缺失/非法都逐条列出，不静默兜底。 */
export declare function loadHubConfig(file: string, overrides?: {
    port?: number;
}): Promise<HubConfig>;
export declare function validateHubConfig(raw: Record<string, unknown>, sourceFile: string, overrides?: {
    port?: number;
}): HubConfig;
export {};
