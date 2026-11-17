type AnySchema = any;
interface HubProfileConfig {
    protocol: string;
    host: string;
    port?: number;
    basePath?: string;
    timeoutMs?: number;
    token?: string;
    /** 可选：hub 管理员令牌。配置后插件可用 Remote 方法代理审批/总库管理请求（面板用）。 */
    adminToken?: string;
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
        /** 写入作用域：""=全局、proj:<p>、proj:<p>:mod:<m>；节点所有 push 都进这个 scope。 */
        scope?: string;
        /** 读取作用域列表；为空时自动取 sync.scope 的继承闭包（""+proj+mod）。 */
        readScopes?: string[];
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
    /** 可选 hub 管理员令牌（面板审批通道用）；缺省时 admin* Remote 方法报明确错误。 */
    adminToken?: string;
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
    /** 写作用域（push 目标）。 */
    writeScope: string;
    /** 读作用域（pull/search 可见集合，已是展开后的精确 scope 列表）。 */
    readScopes: string[];
    stateDir: string;
    logLevel: string;
    logDir: string;
    oneshot: {
        enabled: boolean;
        commands: string[];
        resultFile: string;
    };
}
export declare function resolveNodeConfig(input: NodeSyncConfig, cwd?: string): ResolvedNodeConfig;
export interface HubListenConfig {
    protocol: 'http' | 'https';
    host: string;
    port: number;
    tls?: {
        certFile?: string;
        keyFile?: string;
    };
}
/** 节点令牌 + 作用域授权；scopes 为 grant 列表（scope 精确值或 "*"/"proj:x:*" 通配）。 */
export interface HubNodeCredential {
    token: string;
    scopes: string[];
}
export interface HubConfig {
    listen: HubListenConfig;
    auth: {
        adminToken: string;
        nodeTokens: Record<string, HubNodeCredential>;
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
/** 比较两份已解析配置，返回发生变化的域：client / local / timer / logger（空数组=无实质变化）。 */
export declare function diffResolvedConfig(prev: any, next: any): string[];
export {};
