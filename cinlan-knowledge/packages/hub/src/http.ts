import type { IncomingMessage, ServerResponse } from "node:http";
import { fail, httpStatusOf } from "@cinlan/knowledge-sdk";
import type { Envelope } from "@cinlan/knowledge-sdk";

/** `/api/v1` 与 `/mcp` 共用的收发原语：统一信封的写出、带上限的正文读取。 */

export function sendJson(res: ServerResponse, env: Envelope, head: boolean, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(env);
  res.writeHead(httpStatusOf(env), {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(head ? undefined : body);
}

/** 429：`Retry-After` 头与信封里的 `retry_after` 是同一个秒数，客户端读哪个都行。 */
export function sendRateLimited(res: ServerResponse, request_id: string, retry_after: number): void {
  sendJson(res, fail("RATE_LIMITED", request_id, { detail: "rate limit exceeded", retry_after }), false, {
    "retry-after": String(retry_after),
  });
}

/**
 * 超限后继续丢弃的上限：让 413 有机会写回调用方，而不是把还在上传的 socket 直接掐断
 * （掐断会让客户端拿到 ECONNRESET 而不是统一的错误信封）。超过这个量才强制断开。
 */
const DRAIN_AFTER_LIMIT = 4 * 1024 * 1024;

export function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        if (size > limit + DRAIN_AFTER_LIMIT) req.destroy();
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        // 立即交出结果，让调用方在正文还没收完时就能回 413；后续数据丢弃。
        resolvePromise({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", reject);
  });
}
