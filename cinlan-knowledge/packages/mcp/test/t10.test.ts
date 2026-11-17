import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

/**
 * T10（MCP 契约，双面）：官方 client 分别连真实 hub 的 `/mcp` 与 `ck mcp` 子进程，
 * 同一组调用的结果必须一致；`instructions` 与 `ck hook session-start` 输出的文本同源。
 * 面本身的协议断言见 face.test.ts，这里只管"两条腿是不是同一个东西"。
 *
 * 跑的是 packages/hub 与 packages/cli 的构建产物（先 `pnpm -r build`），不 import 它们的源码：
 * mcp 包在依赖图里位于两者之下，测试不反向引用。
 */

/** `node --test` 的 cwd 是包目录（packages/mcp）。 */
const HUB_BIN = join(process.cwd(), "..", "hub", "lib", "bin.js");
const CK_BIN = join(process.cwd(), "..", "cli", "lib", "bin.js");
const AGENT = "demo/bob";
const ID = /^[a-z]+_[0-9a-f]{24}$/;

let dir = "";
let base = "";
let hub: ChildProcess | undefined;
let hubStderr = "";
let aKey = "";
let bKey = "";
let teamId = "";
let agentId = "";
/** team 可见，inject 绑定：进 instructions。 */
let m1 = "";
/** team 可见，不绑定：只走检索，用来数 opened。 */
let m2 = "";
/** agent 可见，tool 绑定：只有带 Agent 身份才读得到。 */
let ag1 = "";
let hubClient: Client;
let ckClient: Client;
const clients: Client[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (hub === undefined || hub.exitCode !== null) throw new Error(`hub exited early: ${hubStderr}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch {
      // 还没开始监听：继续等到 deadline
    }
    if (Date.now() > deadline) throw new Error(`hub did not become healthy: ${hubStderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** `POST /api/v1/<action>`，非 0 信封直接判失败。 */
async function api(action: string, key: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/v1/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const env = (await res.json()) as { code: number; message: string; data: Record<string, unknown> };
  assert.equal(env.code, 0, `${action}: ${env.message} ${JSON.stringify(env.data)}`);
  return env.data;
}

function idOf(data: Record<string, unknown>, field: string): string {
  return (data[field] as { id: string }).id;
}

/**
 * `ck` 子进程的环境：hub 与 key 走环境变量，本机状态隔离到临时目录。
 * 用户 home 一并隔离：宿主路径里的 `~`（skill 目录）取自 os.homedir()，不随 CK_HOME 走，
 * 不改的话配装里一旦有 inject 的 skill，就会物化进跑测试的人的真实 skill 目录。
 */
function ckEnv(): Record<string, string> {
  const userHome = join(dir, "user-home");
  return { ...getDefaultEnvironment(), CK_HUB_URL: base, CK_USER_KEY: bKey, CK_HOME: join(dir, "ck-home"), USERPROFILE: userHome, HOME: userHome };
}

async function connectHub(host: string, extra: Record<string, string> = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bKey}`, "x-ck-agent": AGENT, "x-ck-host": host, ...extra } },
  });
  const client = new Client({ name: "t10-client", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function connectCk(host: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CK_BIN, "mcp", "--host", host, "--agent", AGENT],
    env: ckEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "t10-client", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

interface Outcome {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  assert.equal(content.length, 1, name);
  return { isError: result.isError === true, text: content[0]?.text ?? "" };
}

/** 同一调用打两面：先 hub `/mcp`，后 `ck mcp`。 */
async function both(name: string, args: Record<string, unknown>): Promise<{ viaHub: Outcome; viaCk: Outcome }> {
  const viaHub = await call(hubClient, name, args);
  const viaCk = await call(ckClient, name, args);
  return { viaHub, viaCk };
}

/** 两面结果逐字节一致，且不是"一起报错"；返回解析后的结果。 */
async function same<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { viaHub, viaCk } = await both(name, args);
  assert.equal(viaHub.isError, false, `${name} via hub: ${viaHub.text}`);
  assert.deepEqual(viaCk, viaHub, `${name} ${JSON.stringify(args)}`);
  return JSON.parse(viaHub.text) as T;
}

before(async () => {
  for (const bin of [HUB_BIN, CK_BIN]) {
    assert.ok(existsSync(bin), `${bin} is missing: run \`pnpm -r build\` first`);
  }
  dir = mkdtempSync(join(tmpdir(), "ck-t10-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = join(dir, "knowledge.config.json");
  writeFileSync(
    config,
    JSON.stringify({ dataDir: join(dir, "data"), listen: { host: "127.0.0.1", port }, log: { level: "error" } }),
  );

  const boot = spawnSync(process.execPath, [HUB_BIN, "bootstrap", "--config", config, "--name", "sa"], { encoding: "utf8" });
  assert.equal(boot.status, 0, boot.stderr);
  const saKey = (JSON.parse(boot.stdout) as { key: string }).key;

  hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout?.resume();
  hub.stderr?.on("data", (chunk: Buffer) => {
    hubStderr += chunk.toString("utf8");
  });
  await waitHealthy();

  const a = await api("user/create-with-key", saKey, { name: "alice", display_name: "Alice", key_name: "k" });
  const b = await api("user/create-with-key", saKey, { name: "bob", display_name: "Bob", key_name: "k" });
  aKey = (a["key"] as { key: string }).key;
  bKey = (b["key"] as { key: string }).key;
  teamId = idOf(await api("team/create", saKey, { name: "demo", title: "Demo" }), "team");
  await api("team-member/add", saKey, { team_id: teamId, user_id: idOf(a, "user"), role: "admin" });
  await api("team-member/add", saKey, { team_id: teamId, user_id: idOf(b, "user"), role: "member" });

  const memory = async (title: string, content: string, visibility: string): Promise<string> => {
    const id = idOf(await api("asset/create", aKey, { team_id: teamId, type: "memory", title, content }), "asset");
    // A 是团队 Admin，默认允许自批：当场生效
    const out = await api("asset/set-visibility", aKey, { asset_id: id, visibility });
    assert.equal(out["status"], "applied", title);
    return id;
  };
  m1 = await memory("构建约定", "pnpm build 后再跑 test", "team");
  m2 = await memory("发布约定", "发布前先打 tag 再出包", "team");
  ag1 = await memory("值班手册", "夜间告警先看 hub 日志", "agent");

  agentId = idOf(await api("agent/ensure", bKey, { team: "demo", name: "bob", host: "dsh" }), "agent");
  await api("loadout/bind", bKey, { agent_id: agentId, asset_id: m1, priority: 0, injection_mode: "inject" });
  // agent 可见的资产由团队 Admin 绑到 Agent 上，绑定本身即授权（data-model §3）
  await api("loadout/bind", aKey, { agent_id: agentId, asset_id: ag1, priority: 10, injection_mode: "tool" });

  hubClient = await connectHub("dsh");
  ckClient = await connectCk("dsh");
});

after(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  if (hub !== undefined && hub.exitCode === null) {
    const exited = new Promise<void>((res) => hub?.once("exit", () => res()));
    hub.kill();
    await exited;
  }
  // Windows 上句柄释放略晚于进程退出
  if (dir !== "") rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("T10 双面：握手一致，都自称 ck", () => {
  const viaHub = hubClient.getServerVersion();
  const viaCk = ckClient.getServerVersion();
  assert.equal(viaHub?.name, "ck");
  // ck 随 hub 的 release 一起构建，版本天然配套（architecture.md §7）
  assert.deepEqual({ name: viaCk?.name, version: viaCk?.version }, { name: viaHub?.name, version: viaHub?.version });
});

test("T10 双面：tools/list 逐字段一致", async () => {
  const viaHub = (await hubClient.listTools()).tools;
  const viaCk = (await ckClient.listTools()).tools;
  assert.equal(viaHub.length, 6);
  assert.deepEqual(viaCk, viaHub);
});

test("T10 双面：同一组读调用结果一致", async () => {
  // knowledge_status 例外：ck 侧有会话级字段（current_digest / changed / stale / skills），
  // hub 侧（A0，无本机状态）不出现（loadout.md §5 末条）——共有子集逐字段比。
  const { viaHub, viaCk } = await both("knowledge_status", {});
  assert.equal(viaHub.isError, false, viaHub.text);
  assert.equal(viaCk.isError, false, viaCk.text);
  const status = JSON.parse(viaHub.text) as {
    hub: { ok: boolean };
    team: { id: string; name: string } | null;
    agent: { id: string; name: string; host: string } | null;
    baseline?: { delivery: string; digest: string };
    loadout?: { items: number };
  };
  const ckStatus = JSON.parse(viaCk.text) as {
    baseline?: { delivery: string; digest: string | null; current_digest: string | null; changed: boolean; stale: boolean };
    skills?: { materialized: number; conflicts: string[] };
    [key: string]: unknown;
  };
  for (const key of ["hub", "user", "team", "agent", "host", "loadout", "reviews"]) {
    assert.deepEqual(ckStatus[key], (status as Record<string, unknown>)[key], `status.${key}`);
  }
  assert.equal(status.hub.ok, true);
  assert.deepEqual(status.team, { id: teamId, name: "demo" });
  assert.deepEqual(status.agent, { id: agentId, name: "bob", host: "dsh" });
  assert.equal(status.baseline?.delivery, "full");
  assert.equal(status.loadout?.items, 2);
  // A0 侧只有 delivery + digest；ck 侧带会话事实：同预算解析 → 与会话 digest 一致、无变更、非缓存
  assert.deepEqual(Object.keys(status.baseline ?? {}).sort(), ["delivery", "digest"]);
  const cb = ckStatus.baseline!;
  assert.equal(cb.delivery, "full");
  assert.equal(cb.digest, cb.current_digest);
  assert.equal(cb.changed, false);
  assert.equal(cb.stale, false);
  assert.equal(cb.digest, status.baseline?.digest);
  assert.deepEqual(ckStatus.skills, { materialized: 0, conflicts: [] });

  const reloadFaces = await both("knowledge_status", { reload: true });
  assert.equal(reloadFaces.viaHub.isError, false, reloadFaces.viaHub.text);
  assert.equal(reloadFaces.viaCk.isError, false, reloadFaces.viaCk.text);
  // reload 文本两侧同源（都是 loadout/resolve 的 text）；会话级字段的口径差见上一块
  assert.equal((JSON.parse(reloadFaces.viaCk.text) as { text?: string }).text, hubClient.getInstructions());
  assert.equal(
    (JSON.parse(reloadFaces.viaCk.text) as { text?: string }).text,
    (JSON.parse(reloadFaces.viaHub.text) as { text?: string }).text,
  );

  const byTeam = await same<{ hits: { id: string }[] }>("knowledge_search", { query: "构建" });
  assert.ok(byTeam.hits.some((h) => h.id === m1));
  // agent 可见的资产：检索范围取决于调用是否带着 Agent 身份
  const byAgent = await same<{ hits: { id: string }[] }>("knowledge_search", { query: "值班手册" });
  assert.ok(byAgent.hits.some((h) => h.id === ag1));

  const open = await same<{ id: string; content: string }>("knowledge_open", { id: m1 });
  assert.equal(open.content, "pnpm build 后再跑 test");
  const openAgentOnly = await same<{ content: string }>("knowledge_open", { id: ag1 });
  assert.equal(openAgentOnly.content, "夜间告警先看 hub 日志");

  // 错误也是结果的一部分：枚举前缀 + 人读说明，两面同文（api.md §5）
  const missing = await both("knowledge_open", { id: m1.replace(/[0-9a-f]{24}$/, "0".repeat(24)) });
  assert.equal(missing.viaHub.isError, true);
  assert.match(missing.viaHub.text, /^NOT_FOUND: /);
  assert.deepEqual(missing.viaCk, missing.viaHub);
});

test("T10 双面：写调用落在同一个团队，冲突与审批的返回一致", async () => {
  const saved: string[] = [];
  for (const [client, via] of [
    [hubClient, "hub"],
    [ckClient, "ck"],
  ] as const) {
    const out = await call(client, "knowledge_save", { title: `经 ${via} 记下的事`, content: "双面写入" });
    assert.equal(out.isError, false, `${via}: ${out.text}`);
    const result = JSON.parse(out.text) as { id: string; version: number; visibility: string };
    assert.match(result.id, ID, via);
    assert.deepEqual({ version: result.version, visibility: result.visibility }, { version: 1, visibility: "private" }, via);
    // 落库的团队取自会话事实，两面必须是同一个 team id
    const got = await api("asset/get", bKey, { asset_id: result.id });
    assert.equal((got["asset"] as { team_id: string }).team_id, teamId, via);
    saved.push(result.id);
  }

  // 过期的 base_version：两面都把 current_version 原样交还
  const target = saved[0] ?? "";
  await api("asset/update", bKey, { asset_id: target, base_version: 1, content: "双面写入，第二版" });
  const stale = await both("knowledge_save", { id: target, base_version: 1, title: "改标题", content: "基于旧版本" });
  assert.equal(stale.viaHub.isError, true);
  assert.match(stale.viaHub.text, /^VERSION_CONFLICT: /);
  assert.match(stale.viaHub.text, /"current_version":2/);
  assert.deepEqual(stale.viaCk, stale.viaHub);

  // 成员共享要审批：两面都回 pending_review + 审批单 id
  for (const [client, id, via] of [
    [hubClient, saved[0] ?? "", "hub"],
    [ckClient, saved[1] ?? "", "ck"],
  ] as const) {
    const out = await call(client, "knowledge_share", { id, visibility: "team", note: "团队都用得上" });
    assert.equal(out.isError, false, `${via}: ${out.text}`);
    const result = JSON.parse(out.text) as { status: string; review_id?: string };
    assert.equal(result.status, "pending_review", via);
    assert.match(result.review_id ?? "", ID, via);
  }
});

test("T10 双面：knowledge_open 都带 Agent 身份，各记一次 opened", async () => {
  const usage = async (): Promise<number> =>
    ((await api("asset/get", aKey, { asset_id: m2 }))["asset"] as { usage_count: number }).usage_count;
  const start = await usage();
  await call(hubClient, "knowledge_open", { id: m2 });
  assert.equal(await usage(), start + 1, "via hub");
  await call(ckClient, "knowledge_open", { id: m2 });
  assert.equal(await usage(), start + 2, "via ck");
});

test("T10：instructions 与 hook 输出同源（都是 loadout/resolve 的文本）", async () => {
  const resolved = await api("loadout/resolve", bKey, { agent_id: agentId });
  const text = resolved["text"] as string;
  assert.match(text, /构建约定/);
  assert.equal(hubClient.getInstructions(), text);
  assert.equal(ckClient.getInstructions(), text);

  const hook = spawnSync(process.execPath, [CK_BIN, "hook", "session-start", "--host", "claude-code", "--agent", AGENT], {
    env: ckEnv(),
    encoding: "utf8",
  });
  assert.equal(hook.status, 0, hook.stderr);
  const out = JSON.parse(hook.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, text);
});

test("T10 双面：brief 同文，工具照常可调", async () => {
  // claude-code 的 instructions 送达方式是 brief（hosts.md §3）；hub 侧用 x-ck-baseline 取同一份
  const viaHub = await connectHub("claude-code", { "x-ck-baseline": "brief" });
  const viaCk = await connectCk("claude-code");
  const brief = viaHub.getInstructions() ?? "";
  assert.match(brief, /^<cinlan_knowledge_brief team="demo" agent="bob">/);
  assert.equal(viaCk.getInstructions(), brief);

  const hubStatus = await call(viaHub, "knowledge_status", {});
  const ckStatus = await call(viaCk, "knowledge_status", {});
  assert.equal(hubStatus.isError, false, hubStatus.text);
  assert.equal(ckStatus.isError, false, ckStatus.text);
  const hb = JSON.parse(hubStatus.text) as { baseline: { delivery: string; digest: string } };
  const cb = JSON.parse(ckStatus.text) as {
    baseline: { delivery: string; digest: string | null; current_digest: string | null; changed: boolean; stale: boolean };
    skills?: { materialized: number; conflicts: string[] };
  };
  assert.equal(hb.baseline.delivery, "brief");
  assert.deepEqual(Object.keys(hb.baseline).sort(), ["delivery", "digest"]);
  assert.equal(cb.baseline.delivery, "brief");
  // brief 不解析：会话 digest 为 null；物化清单为空（0 已物化、无冲突）
  assert.equal(cb.baseline.digest, null);
  assert.equal(cb.baseline.changed, false);
  assert.equal(cb.baseline.stale, false);
  assert.deepEqual(cb.skills, { materialized: 0, conflicts: [] });
});
