import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import type { Db, Principal } from "@cinlan/knowledge-core";
import { getAgent, isDomainError, notFound } from "@cinlan/knowledge-core";
import type { User } from "@cinlan/knowledge-core";
import { fail, ok } from "@cinlan/knowledge-sdk";
import type { ErrorCode } from "@cinlan/knowledge-sdk";
import { authenticate, originAllowed } from "./auth.js";
import { isKnownAction } from "./registry.js";
import { getHandler } from "./actions.js";
import type { HubConfig } from "./config.js";
import { readBody, sendJson, sendRateLimited } from "./http.js";
import { handleMcp } from "./mcp.js";
import { servePanel } from "./panel.js";
import { createRateLimiter, DEFAULT_RATE_LIMIT, type RateLimiter } from "./ratelimit.js";

export const SERVER_VERSION = "0.1.0";

export interface ServerDeps {
  db: Db;
  config: HubConfig;
  /** panel 构建产物（`vite build` 的 dist）所在目录；不给或目录里没有 index.html 时 `/panel/` 回 404 */
  panelDir?: string;
}

/** 处理一个请求要的全套：依赖 + 这个 hub 实例的限流计数（跨请求共用，`/api/v1` 与 `/mcp` 同一份）。 */
export interface RequestDeps extends ServerDeps {
  limiter: RateLimiter;
}

const MIME: Record<string, string> = {
  ".tgz": "application/gzip",
  ".sha256": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function requestId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && /^[\w.:-]{1,128}$/.test(value)) return value;
  return `req_${randomBytes(12).toString("hex")}`;
}

function sendError(
  res: ServerResponse,
  code: ErrorCode,
  request_id: string,
  detail: string,
  head = false,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, fail(code, request_id, { detail, ...extra }), head);
}

/** /dl/* 只服务 <dataDir>/dl 下的直接文件，不走子目录、不跟随路径穿越。 */
async function serveDownload(config: HubConfig, name: string, res: ServerResponse, request_id: string, head: boolean): Promise<void> {
  const safeName = basename(normalize(name));
  if (safeName === "" || safeName !== name) {
    sendError(res, "NOT_FOUND", request_id, "not found", head);
    return;
  }
  const root = resolve(join(config.dataDir, "dl"));
  const file = resolve(root, safeName);
  if (!file.startsWith(root + sep)) {
    sendError(res, "NOT_FOUND", request_id, "not found", head);
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[extname(safeName)] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-cache",
    });
    if (head) {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    sendError(res, "NOT_FOUND", request_id, "not found", head);
  }
}

export async function handleRequest(deps: RequestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rid = requestId(req);
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const head = req.method === "HEAD";

  if (path === "/healthz") {
    if (req.method !== "GET" && !head) {
      sendError(res, "METHOD_NOT_ALLOWED", rid, "use GET");
      return;
    }
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    res.end(head ? undefined : body);
    return;
  }

  if (path === "/") {
    res.writeHead(302, { location: "/panel/" });
    res.end();
    return;
  }

  if (path.startsWith("/dl/")) {
    if (req.method !== "GET" && !head) {
      sendError(res, "METHOD_NOT_ALLOWED", rid, "use GET");
      return;
    }
    await serveDownload(deps.config, decodeURIComponent(path.slice("/dl/".length)), res, rid, head);
    return;
  }

  if (path === "/panel") {
    res.writeHead(302, { location: "/panel/" });
    res.end();
    return;
  }

  if (path.startsWith("/panel/")) {
    if (req.method !== "GET" && !head) {
      sendError(res, "METHOD_NOT_ALLOWED", rid, "use GET");
      return;
    }
    if (!originAllowed(deps.config.listen, req)) {
      sendError(res, "FORBIDDEN", rid, "origin not allowed", head);
      return;
    }
    const served = await servePanel(deps.panelDir, path.slice("/panel/".length), res, head);
    if (served !== "sent") sendError(res, "NOT_FOUND", rid, served === "not_built" ? "panel is not built" : "not found", head);
    return;
  }

  if (path === "/mcp") {
    await handleMcp({ db: deps.db, config: deps.config, limiter: deps.limiter, server_version: SERVER_VERSION }, req, res, rid);
    return;
  }

  const apiPrefix = "/api/v1/";
  if (!path.startsWith(apiPrefix)) {
    sendError(res, "NOT_FOUND", rid, "no route");
    return;
  }

  if (req.method !== "POST") {
    sendError(res, "METHOD_NOT_ALLOWED", rid, "business routes are POST only");
    return;
  }

  if (!originAllowed(deps.config.listen, req)) {
    sendError(res, "FORBIDDEN", rid, "origin not allowed");
    return;
  }

  const action = path.slice(apiPrefix.length);
  if (!isKnownAction(action)) {
    sendError(res, "UNKNOWN_ACTION", rid, `unknown action ${action}`);
    return;
  }
  const handler = getHandler(action);
  if (!handler) {
    sendError(res, "UNKNOWN_ACTION", rid, `action not implemented: ${action}`);
    return;
  }

  const auth = authenticate(deps.db, req.headers);
  if (!auth.ok) {
    sendError(res, auth.status, rid, auth.detail);
    return;
  }
  // 认出 key 之后、读正文之前：超额的请求不再花读写的成本
  const admitted = deps.limiter.hit(auth.principal.key_id);
  if (!admitted.ok) {
    sendRateLimited(res, rid, admitted.retry_after);
    return;
  }

  const body = await readBody(req, deps.config.limits.maxBodyBytes);
  if (!body.ok) {
    sendError(res, "PAYLOAD_TOO_LARGE", rid, `body exceeds ${deps.config.limits.maxBodyBytes} bytes`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
  } catch {
    sendError(res, "INVALID_ARGUMENT", rid, "body is not valid JSON");
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendError(res, "INVALID_ARGUMENT", rid, "body must be a JSON object");
    return;
  }

  try {
    const principal = resolvePrincipal(deps.db, auth.principal.user, req);
    const data = handler(
      {
        db: deps.db,
        user: auth.principal.user,
        principal,
        request_id: rid,
        server_version: SERVER_VERSION,
        data_dir: deps.config.dataDir,
      },
      parsed as Record<string, unknown>,
    );
    sendJson(res, ok(data, rid), head);
  } catch (err) {
    // DomainError 按业务码原样回传；其余异常一律 INTERNAL，不降级成 400
    if (isDomainError(err)) {
      sendError(res, err.code, rid, err.detail, false, err.data);
      return;
    }
    process.stderr.write(`${JSON.stringify({ level: "error", request_id: rid, action, error: (err as Error).message })}\n`);
    sendError(res, "INTERNAL", rid, "internal error");
  }
}

/**
 * `x-ck-agent-id` 只在本请求内生效：必须是该用户名下的 active Agent，否则 NOT_FOUND
 * （与 api.md 一致——不可见的资源不确认存在）。
 */
function resolvePrincipal(db: Db, user: User, req: IncomingMessage): Principal {
  const header = req.headers["x-ck-agent-id"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || raw === "") return { user: { id: user.id } };
  const agent = getAgent(db, raw);
  if (!agent || agent.owner_user_id !== user.id || agent.status !== "active") {
    throw notFound("agent not found");
  }
  return { user: { id: user.id }, agent: { id: agent.id, owner_user_id: agent.owner_user_id } };
}

export function createHubServer(deps: ServerDeps): Server {
  const full: RequestDeps = { ...deps, limiter: createRateLimiter(deps.config.limits.rateLimit ?? DEFAULT_RATE_LIMIT) };
  return createServer((req, res) => {
    handleRequest(full, req, res).catch((err: Error) => {
      if (!res.headersSent) {
        sendJson(res, fail("INTERNAL", requestId(req), { detail: "internal error" }), false);
      }
      process.stderr.write(`${JSON.stringify({ level: "error", error: err.message })}\n`);
    });
  });
}
