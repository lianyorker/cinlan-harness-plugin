import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { createKnowledgeServer } from "./server.js";
import type { McpFaceSession } from "./face.js";

/**
 * stdio 面：`ck mcp` 用，把同一份工具定义接到进程 stdio 上。
 * 与 HTTP 面（face.ts）共享 `McpFaceSession`，注入方仍只提供 Rpc 与会话事实。
 *
 * 生命周期由 stdio 绑定决定：一个连接一个实例；stdin 关闭即退出（MCP stdio 规范）。
 * 不用 `serveStdio` 工厂：那个入口要自己判时代，和 face 一样直接指定 2025 语义更清楚。
 */

export interface StdioFaceHandle {
  /** 连接关闭（stdin EOF 或客户端断开）时 resolve。 */
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface StdioFaceOptions {
  onerror?: (error: Error) => void;
  /** 缺省 stdin/stdout；测试可换成内存流。 */
  input?: Readable;
  output?: Writable;
}

export async function createStdioFace(session: McpFaceSession, options: StdioFaceOptions = {}): Promise<StdioFaceHandle> {
  const report = (err: unknown): void => {
    if (options.onerror === undefined) return;
    options.onerror(err instanceof Error ? err : new Error(String(err)));
  };

  let instructions: string;
  try {
    instructions = await session.instructions();
  } catch (err) {
    report(err);
    throw err;
  }

  const server = createKnowledgeServer({ rpc: session.rpc, ctx: session.ctx, instructions });
  const transport = new StdioServerTransport(options.input, options.output);
  const closed = new Promise<void>((resolvePromise) => {
    transport.onclose = () => resolvePromise();
  });
  transport.onerror = report;
  await server.connect(transport);

  return {
    closed,
    close: async () => {
      await server.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
