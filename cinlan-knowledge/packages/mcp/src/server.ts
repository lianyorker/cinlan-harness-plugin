import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { EmbedFn, McpContext, KnowledgeRpc } from "./types.js";
import { KnowledgeRpcError } from "./types.js";
import { TOOLS } from "./tools.js";

/**
 * 把工具注册到一个 `McpServer` 实例上。
 * `createMcpHandler` 每个 HTTP 请求建一个实例，所以身份相关的状态一律从闭包进。
 */

export const SERVER_NAME = "ck";

export interface KnowledgeServerOptions {
  rpc: KnowledgeRpc;
  ctx: McpContext;
  /** `initialize` 返回的 instructions；brief 或完整配装文本。 */
  instructions: string;
  /** O-9 查询向量注入（可选；hub `/mcp` 不带，`ck mcp` 带）。 */
  embed?: EmbedFn;
}

type AnyTool = (typeof TOOLS)[number];

function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  // 错误枚举前缀由 KnowledgeRpcError 的 message 给出（"CODE: 说明"）；
  // 其他异常不伪装成业务错误，原样带出。
  let text = err instanceof Error ? err.message : String(err);
  // 信封 data 里的细节（VERSION_CONFLICT 的 current_version、INVALID_ARGUMENT 的 issues）原样附在后面
  if (err instanceof KnowledgeRpcError && Object.keys(err.data).length > 0) text += ` ${JSON.stringify(err.data)}`;
  return { content: [{ type: "text", text }], isError: true };
}

export function registerTools(server: McpServer, rpc: KnowledgeRpc, ctx: McpContext, embed?: EmbedFn): void {
  const deps = { rpc, ctx, embed };
  for (const tool of TOOLS as readonly AnyTool[]) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>,
      },
      (async (input: unknown) => {
        try {
          const out = await (tool.run as (d: typeof deps, i: unknown) => Promise<unknown>)(deps, input);
          return textResult(out);
        } catch (err) {
          return errorResult(err);
        }
      }) as never,
    );
  }
}

export function createKnowledgeServer(options: KnowledgeServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.rpc.server_version },
    { instructions: options.instructions },
  );
  registerTools(server, options.rpc, options.ctx, options.embed);
  return server;
}
