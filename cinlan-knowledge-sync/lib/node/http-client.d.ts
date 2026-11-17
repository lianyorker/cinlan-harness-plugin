import type { ResolvedProfile } from '../config.js';
import type { Logger } from '../logger.js';
export declare class HubClient {
    private readonly profile;
    private readonly logger;
    private agent?;
    constructor(profile: ResolvedProfile, logger: Logger);
    baseUrl(): string;
    describe(): string;
    /** 连通性探测：GET /healthz（无需 token）。 */
    health(): Promise<{
        ok: boolean;
        service?: string;
        stats?: unknown;
    }>;
    /**
     * 管理员通道：与 request 相同，但 Bearer 换成 profiles.<p>.adminToken。
     * 供 Remote 代理方法（面板审批/总库管理）调用；未配置 adminToken 时给可定位错误。
     */
    adminRequest<T>(method: 'GET' | 'POST' | 'PUT', pathName: string, opts?: {
        body?: unknown;
        query?: Record<string, string>;
    }): Promise<T>;
    request<T>(method: 'GET' | 'POST' | 'PUT', pathName: string, opts?: {
        body?: unknown;
        headers?: Record<string, string>;
        auth?: boolean;
        query?: Record<string, string>;
    }): Promise<T>;
    private rawRequest;
    private mapNetworkError;
    private getAgent;
}
