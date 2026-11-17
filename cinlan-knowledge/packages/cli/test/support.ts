import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 测试用假 hub：按 `POST /api/v1/<action>` 分发，记录调用顺序。
 * 返回 "network" 表示模拟网络故障（fetch 直接抛错）。
 */

/**
 * 生产默认路径的夹具：不传 `home` 时，"用户 home"（宿主路径里 `~` 的展开根）
 * 与 "ck 状态目录"（CK_HOME）是两个目录。这里把两者指到不同的临时目录，
 * 用来钉住"两者不能混用"；结束后还原环境变量并删目录。
 */
export async function withSplitHomes(fn: (homes: { userHome: string; stateHome: string }) => Promise<void>): Promise<void> {
  const userHome = mkdtempSync(join(tmpdir(), "ck-user-"));
  const stateHome = mkdtempSync(join(tmpdir(), "ck-state-"));
  const names = ["USERPROFILE", "HOME", "CK_HOME"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  // Windows 的 homedir() 读 USERPROFILE，POSIX 读 HOME：两个都改
  process.env["USERPROFILE"] = userHome;
  process.env["HOME"] = userHome;
  process.env["CK_HOME"] = stateHome;
  try {
    // 夹具没生效就别往下跑：否则被测代码会写进真实的用户目录
    if (homedir() !== userHome) throw new Error(`homedir() did not follow the override: ${homedir()}`);
    await fn({ userHome, stateHome });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(userHome, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
}

export interface FakeCall {
  action: string;
  body: Record<string, unknown>;
  /** `x-ck-agent-id` 请求头；没带是 null。 */
  agent: string | null;
}

export interface FakeReply {
  code?: number;
  message?: string;
  data?: unknown;
}

export type FakeHandler = (action: string, body: Record<string, unknown>) => FakeReply | "network";

/** 假 hub 的应答：HTTP 状态码 + 信封正文。两种假 hub 共用，形状只在这里定一次。 */
function wire(reply: FakeReply): { status: number; payload: string } {
  const code = reply.code ?? 0;
  return {
    status: code === 0 ? 200 : code,
    payload: JSON.stringify({ code, message: reply.message ?? (code === 0 ? "OK" : "ERROR"), request_id: "req_test", data: reply.data ?? {} }),
  };
}

export function hubFetch(handler: FakeHandler): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const action = url.slice(url.indexOf("/api/v1/") + "/api/v1/".length);
    const body: Record<string, unknown> = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ action, body, agent: new Headers(init?.headers).get("x-ck-agent-id") });
    const reply = handler(action, body);
    if (reply === "network") throw new Error("ECONNREFUSED");
    const { status, payload } = wire(reply);
    return new Response(payload, { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

/**
 * 真的在 127.0.0.1 上监听的假 hub：给"起真实 `ck` 进程"的测试用——子进程里注入不了 fetchImpl。
 * 分发与应答同 hubFetch；"network" 是直接断开连接。用完必须 close()。
 */
export async function httpHub(handler: FakeHandler): Promise<{ url: string; calls: FakeCall[]; close: () => Promise<void> }> {
  const calls: FakeCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const action = url.slice(url.indexOf("/api/v1/") + "/api/v1/".length);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const agent = req.headers["x-ck-agent-id"];
      calls.push({ action, body, agent: typeof agent === "string" ? agent : null });
      const reply = handler(action, body);
      if (reply === "network") {
        req.socket.destroy();
        return;
      }
      const { status, payload } = wire(reply);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 固定 resolve 结果：够 prepare / mcp / hook 用。 */
export function resolveData(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    not_modified: false,
    digest: `digest-${text.length}-${text.slice(0, 4)}`,
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    text,
    items: [{ asset_id: "ast_1", version: 1 }],
    skills: [],
    skipped: [],
    downgraded: 0,
    generated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** prepare 两步 + 上报的最小应答：agent/ensure + loadout/resolve + usage/report。 */
export function basicHub(resolveReply: (body: Record<string, unknown>) => FakeReply | "network", agentId = "ag_1") {
  return hubFetch((action, body) => {
    if (action === "agent/ensure") return { data: { agent: { id: agentId, team_id: "tem_1" } } };
    if (action === "loadout/resolve") return resolveReply(body);
    if (action === "usage/report") return { data: {} };
    return { code: 404, message: "NOT_FOUND" };
  });
}
