/**
 * hub HTTP 服务：REST + JSON，Bearer token 双角色认证（node / admin）。
 * 每个请求都记日志；任何错误都以 {error:{code,message}} 返回并写日志，不静默。
 * listen.protocol=https 时加载 certFile/keyFile 以 TLS 对外服务（外网部署）。
 */
import { type Server } from 'node:http';
import type { HubConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { HubStore, type EntryKind } from './store.js';
export interface HubRuntime {
    server: Server;
    port: number;
    store: HubStore;
    close(): Promise<void>;
}
export declare function startHubServer(cfg: HubConfig, logger: Logger): Promise<HubRuntime>;
export type { EntryKind };
