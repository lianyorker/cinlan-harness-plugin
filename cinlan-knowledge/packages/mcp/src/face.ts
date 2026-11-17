import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createKnowledgeServer } from "./server.js";
import { briefInstructions } from "./instructions.js";
import type { EmbedFn, KnowledgeRpc, McpContext } from "./types.js";

/**
 * HTTP 面：把 MCP 的 2025 时代协议接上注入方（hub 的 `/mcp`、`ck mcp`）。
 * 本包是全仓库唯一 import MCP SDK 的地方；注入方只提供 `KnowledgeRpc` 与会话事实。
 *
 * 无状态、只回 JSON（api.md §5）：
 * - 每个 POST 建一个 `McpServer` + 一个 `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`，
 *   请求结束即拆，不持有会话；
 * - `enableJsonResponse: true` 让 transport 用 `Response.json` 回终态，不起 SSE。
 *   这是刻意手工接线：`createMcpHandler` 的 2025 静态路径固定不开这个选项，`responseMode` 只管 2026 路径。
 * - GET / DELETE 是会话操作，无状态部署回 405（SDK 的语义，这里等价手写）。
 */

/** 一个 HTTP 请求的会话：身份、Rpc、instructions 取值方式都由注入方决定。 */
export interface McpFaceSession {
  /** 进程内 Rpc：落到注入方自己的动作注册表。 */
  rpc: KnowledgeRpc;
  /** 请求头 / 本地配置里解析出的会话事实。 */
  ctx: McpContext;
  /** 只有 `initialize` 会调；注入方在这里决定 brief 还是完整配装。 */
  instructions: () => Promise<string>;
  /** O-9 查询向量注入（可选）：注入方配置了模型端点才带；hub `/mcp` 不带。 */
  embed?: EmbedFn;
}

export interface McpFace {
  fetch(request: Request, session: McpFaceSession, parsedBody?: unknown): Promise<Response>;
  close(): Promise<void>;
}

export interface McpFaceOptions {
  /** 传输层异常上报（不改变响应）。 */
  onerror?: (error: Error) => void;
}

/** 只有握手需要 instructions；其余方法给 brief，避免每个 tools/call 都跑 resolve。 */
function isHandshake(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const method = (body as { method?: unknown }).method;
  return method === "initialize" || method === "server/discover";
}

function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: "POST", "Content-Type": "application/json" } },
  );
}

export function createMcpFace(options: McpFaceOptions = {}): McpFace {
  const report = (err: unknown): void => {
    if (options.onerror === undefined) return;
    options.onerror(err instanceof Error ? err : new Error(String(err)));
  };

  return {
    async fetch(request: Request, session: McpFaceSession, parsedBody?: unknown): Promise<Response> {
      if (request.method.toUpperCase() !== "POST") return methodNotAllowed();

      let instructions: string;
      try {
        instructions = isHandshake(parsedBody) ? await session.instructions() : briefInstructions(session.ctx);
      } catch (err) {
        report(err);
        throw err;
      }

      const server = createKnowledgeServer({ rpc: session.rpc, ctx: session.ctx, instructions, embed: session.embed });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request, parsedBody === undefined ? {} : { parsedBody });
      } catch (err) {
        report(err);
        return Response.json(
          { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      } finally {
        // 无状态：终态已经成形（JSON 模式），连接与实例就地拆掉。
        // SSE 模式下也要在流结束后拆，但本面永远走 JSON，所以 finally 是安全的。
        transport.close().catch(() => {});
        server.close().catch(() => {});
      }
    },
    // 无状态面没有需要跨请求保留的东西。
    close: () => Promise.resolve(),
  };
}
