import type { Envelope } from "@cinlan/knowledge-sdk";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly request_id: string | null,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcOptions {
  hub: string;
  key: string;
  action: string;
  body: Record<string, unknown>;
  /** 运行面动作的 Agent 身份，写进 `x-ck-agent-id`（api.md §1）；管理面调用不传。 */
  agentId?: string;
  /** 超时，毫秒；缺省 15s */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * POST /api/v1/<action>。信封解析后原样返回；
 * 网络层失败抛 RpcError（无信封）。4xx/5xx 不在这里分支，由调用方看 code。
 */
export async function rpc(options: RpcOptions): Promise<Envelope> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(`${options.hub}/api/v1/${options.action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.key}`,
        "content-type": "application/json",
        ...(options.agentId !== undefined ? { "x-ck-agent-id": options.agentId } : {}),
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as Envelope;
    } catch {
      throw new RpcError(`invalid response from hub (HTTP ${res.status})`, null);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = (err as Error).name === "AbortError" ? "request timed out" : (err as Error).message;
    throw new RpcError(`cannot reach hub: ${message}`, null);
  } finally {
    clearTimeout(timer);
  }
}
