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
