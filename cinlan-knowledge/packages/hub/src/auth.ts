import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Db } from "@cinlan/knowledge-core";
import { verifyUserKey, type VerifiedPrincipal } from "@cinlan/knowledge-core";
import type { ErrorCode } from "@cinlan/knowledge-sdk";
import type { HubConfig } from "./config.js";

export interface Denied {
  ok: false;
  status: ErrorCode;
  detail: string;
}

export type GateResult = { ok: true; principal: VerifiedPrincipal } | Denied;

/**
 * 认证只认 Authorization: Bearer <user-key>，不看 cookie。
 * 401 不带 OAuth 元数据（不发 WWW-Authenticate），避免客户端跳 OAuth 发现。
 */
export function authenticate(db: Db, headers: IncomingHttpHeaders): GateResult {
  const auth = headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    return { ok: false, status: "UNAUTHORIZED", detail: "missing bearer token" };
  }
  const result = verifyUserKey(db, auth.slice("Bearer ".length).trim());
  if (!result.ok) return { ok: false, status: "UNAUTHORIZED", detail: `key ${result.reason}` };
  return { ok: true, principal: result.principal };
}

/**
 * 带 Origin 头且不在白名单 → 403。不带 Origin 的客户端（ck、服务端 MCP 客户端）放行。
 * 认证只认 Authorization 头，因此这条只防浏览器跨站请求。
 */
export function checkOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * hub 自己的源（install.md §1：`allowedOrigins` 留空表示只允许 hub 自己）——panel 由 hub 托管，
 * 浏览器里的同源 POST 也带 Origin。从监听配置推，不看请求的 Host 头：Host 是对方给的，
 * 照它放行等于没防 DNS rebinding。
 * 监听回环或通配地址时只认回环名；经别的主机名访问的，把那个源写进 `allowedOrigins`。
 */
export function ownOrigins(listenHost: string, port: number): string[] {
  const names = LOOPBACK_HOSTS.has(listenHost) || WILDCARD_HOSTS.has(listenHost) ? LOOPBACK : [listenHost.includes(":") ? `[${listenHost}]` : listenHost];
  return names.flatMap((name) => (port === 80 ? [`http://${name}`, `http://${name}:80`] : [`http://${name}:${port}`]));
}

/** `/api/v1`、`/mcp`、`/panel` 共用的 Origin 闸；端口取这条连接实际落在的那个（配置里可以是 0）。 */
export function originAllowed(listen: HubConfig["listen"], req: IncomingMessage): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  return checkOrigin(origin, [...listen.allowedOrigins, ...ownOrigins(listen.host, req.socket.localPort ?? listen.port)]);
}
