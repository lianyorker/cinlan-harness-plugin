import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpFace } from "../src/face.js";
import { briefInstructions } from "../src/instructions.js";
import { KnowledgeRpcError } from "../src/types.js";
import type { EmbedFn, KnowledgeRpc, McpContext } from "../src/types.js";

/**
 * T10（MCP 契约）：用官方 `@modelcontextprotocol/client` 连接本包的 HTTP 面。
 * hub 的 `/mcp` 与 `ck mcp` 共用同一个 `createMcpFace`，所以这里针对面本身断言：
 * 握手、工具清单、工具调用、错误枚举、instructions 出处、以及"只回 JSON"。
 * hub 挂载层的 HTTP 契约另见 packages/hub/test/mcp.test.ts。
 */

const SERVER_VERSION = "0.1.0-test";

const ctx: McpContext = {
  agent_id: "agt_demo",
  agent_name: "bob-cc",
  team_id: "tem_demo",
  team_name: "demo",
  host: "claude-code",
  baseline: "full",
};

const LOADOUT_TEXT =
  '<cinlan_knowledge team="demo" agent="bob-cc" digest="d41d8cd98f00b204e9800998ecf8427e">\n' +
  "<core>\n## 构建约定  (mem_1  v1)\npnpm build 后再跑 test\n</core>\n" +
  '<catalog>\n- mem_2  私人备忘\n</catalog>\n' +
  "<tools>\nknowledge_search 查团队与个人记忆；\n</tools>\n" +
  "</cinlan_knowledge>";

interface FakeState {
  calls: { action: string; body: Record<string, unknown> }[];
  assets: Map<string, { id: string; title: string; content: string; version: number }>;
}

function makeRpc(state: FakeState): KnowledgeRpc {
  return {
    server_version: SERVER_VERSION,
    async call(action, body) {
      state.calls.push({ action, body });
      switch (action) {
        case "auth/verify":
          return {
            user: { id: "usr_bob", name: "bob", display_name: "Bob" },
            teams: [{ team_id: "tem_demo", team: "demo", role: "member" }],
            server_version: SERVER_VERSION,
          };
        case "agent/get":
          return { agent: { id: ctx.agent_id, name: "bob-cc", host: "claude-code", status: "active" } };
        case "loadout/resolve":
          return {
            not_modified: false,
            digest: "d41d8cd98f00b204e9800998ecf8427e",
            chars: LOADOUT_TEXT.length,
            bytes: Buffer.byteLength(LOADOUT_TEXT),
            text: LOADOUT_TEXT,
            items: [{ asset_id: "mem_1", version: 1 }],
            skills: [],
            skipped: [],
            downgraded: 0,
          };
        case "usage/report":
          return { recorded: (body["events"] as unknown[]).length };
        case "asset/search":
          return {
            hits: [
              {
                asset_id: "mem_1",
                type: "memory",
                title: "构建约定",
                summary: "pnpm build 后再跑 test",
                snippet: "pnpm build 后再跑 <mark>test</mark>",
                score: 1.5,
                version: 1,
                visibility: "team",
                owner: { id: "usr_alice", name: "alice" },
                deprecated: false,
              },
            ],
          };
        case "asset/get": {
          const asset = state.assets.get(body["asset_id"] as string);
          if (!asset) throw new KnowledgeRpcError("NOT_FOUND", "asset not found");
          return { asset: { id: asset.id, type: "memory", title: asset.title }, version: { version: asset.version, content: asset.content } };
        }
        case "asset/create":
          return { asset: { id: "mem_new", version: 1, visibility: "private" } };
        case "session/report":
          return {
            drafts: (body["candidates"] as { title: string }[]).map((c, i) => ({
              id: `mem_draft_${i}`,
              title: c.title,
              visibility: "private",
              status: "draft",
            })),
          };
        case "review/list":
          return { items: [] };
        default:
          throw new KnowledgeRpcError("UNKNOWN_ACTION", `unknown action ${action}`);
      }
    },
  };
}

interface Harness {
  face: ReturnType<typeof createMcpFace>;
  session: {
    rpc: KnowledgeRpc;
    ctx: McpContext;
    instructions: () => Promise<string>;
  };
}

/**
 * 会话登记表：官方 client 的 fetch 是普通函数，拿不到测试局部变量，
 * 所以每条连接用 `x-ck-session` 头把请求路由回自己的 Harness。
 */
const sessions = new Map<string, Harness>();

/** 把官方 client 的 fetch 转成对 face 的进程内调用，请求与响应都走真实的 Web 类型。 */
async function bridge(input: string | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const id = req.headers.get("x-ck-session") ?? "";
  const harness = sessions.get(id);
  assert.ok(harness, `unknown session ${id}`);
  const text = await req.clone().text();
  const parsed: unknown = text === "" ? undefined : JSON.parse(text);
  return harness.face.fetch(req, harness.session, parsed);
}

async function connect(options: { baseline?: "brief" | "full"; session?: McpContext["session"]; embed?: EmbedFn } = {}): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  state: FakeState;
  harness: Harness;
  errors: Error[];
  close: () => Promise<void>;
}> {
  const state: FakeState = {
    calls: [],
    assets: new Map([
      ["mem_1", { id: "mem_1", title: "构建约定", content: "pnpm build 后再跑 test", version: 3 }],
    ]),
  };
  const errors: Error[] = [];
  const face = createMcpFace({ onerror: (err) => errors.push(err) });
  const thisCtx: McpContext = { ...ctx, baseline: options.baseline ?? "full" };
  if (options.session !== undefined) thisCtx.session = options.session;
  // 注入方的 instructions 取值与 hub/src/mcp.ts 同构：brief 走固定骨架，full 走 loadout/resolve。
  const rpc = makeRpc(state);
  const harness: Harness = {
    face,
    session: {
      rpc,
      ctx: thisCtx,
      instructions: async () => {
        if (thisCtx.baseline === "brief") return briefInstructions(thisCtx);
        const out = (await rpc.call("loadout/resolve", { team_id: thisCtx.team_id })) as { text: string; items: { asset_id: string; version: number }[] };
        await rpc.call("usage/report", {
          events: out.items.map((i) => ({ asset_id: i.asset_id, version: i.version, kind: "injected" })),
        });
        return out.text;
      },
      ...(options.embed !== undefined ? { embed: options.embed } : {}),
    },
  };
  const id = `s${sessions.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(id, harness);
  const transport = new StreamableHTTPClientTransport(new URL("http://ck.test/mcp"), {
    fetch: bridge,
    requestInit: {
      headers: { "x-ck-session": id, "x-ck-agent": "demo/bob-cc", authorization: "Bearer ck_test" },
    },
  });
  const client = new Client({ name: "t10-client", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    state,
    harness,
    errors,
    close: async () => {
      await client.close();
      await face.close();
      sessions.delete(id);
    },
  };
}

test("T10: official client completes the handshake against the face", async () => {
  const { client, state, close } = await connect();
  try {
    const info = client.getServerVersion();
    assert.deepEqual({ name: info?.name, version: info?.version }, { name: "ck", version: SERVER_VERSION });
    // instructions 就是注入方给的配装文本，一字不差
    assert.equal(client.getInstructions(), LOADOUT_TEXT);
    // 完整配装送出后记一次 injected（data-model §7 的 A0）
    const report = state.calls.find((c) => c.action === "usage/report");
    assert.ok(report);
    assert.deepEqual(report.body["events"], [{ asset_id: "mem_1", version: 1, kind: "injected" }]);
  } finally {
    await close();
  }
});

test("T10: tools/list exposes exactly the six knowledge tools", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "knowledge_open",
      "knowledge_save",
      "knowledge_search",
      "knowledge_session_report",
      "knowledge_share",
      "knowledge_status",
    ]);
    for (const tool of tools) assert.ok((tool.description ?? "").length > 0, tool.name);
  } finally {
    await close();
  }
});

test("T10: tool calls route to the injected Rpc and errors use the enum prefix", async () => {
  const { client, state, close } = await connect();
  try {
    const search = await client.callTool({ name: "knowledge_search", arguments: { query: "构建" } });
    assert.equal(search.isError, undefined);
    const hits = (JSON.parse(textOf(search)) as { hits: { id: string; owner: string }[] }).hits;
    assert.deepEqual(hits.map((h) => [h.id, h.owner]), [["mem_1", "alice"]]);
    const searchCall = state.calls.filter((c) => c.action === "asset/search").at(-1);
    // 团队范围来自会话事实，不由模型决定
    assert.equal(searchCall?.body["team_id"], "tem_demo");

    const open = await client.callTool({ name: "knowledge_open", arguments: { id: "mem_1" } });
    assert.equal((JSON.parse(textOf(open)) as { content: string }).content, "pnpm build 后再跑 test");

    const missing = await client.callTool({ name: "knowledge_open", arguments: { id: "mem_404" } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /^NOT_FOUND: /);
  } finally {
    await client.close();
  }
});

// 自动沉淀（O-7 通道 A' 模型自报）：候选直落草稿，team 与 session_id 由会话事实/入参决定
test("knowledge_session_report: candidates reach session/report as private drafts", async () => {  const { client, state, close } = await connect();
  try {
    const out = await client.callTool({
      name: "knowledge_session_report",
      arguments: {
        candidates: [{ title: "夜班教训", content: "先回滚止血，再定位根因。", layer: "atom" }],
        session_id: "sess_face_1",
      },
    });
    assert.equal(out.isError, undefined);
    const drafts = (JSON.parse(textOf(out)) as { drafts: { id: string; status: string }[] }).drafts;
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.status, "draft");
    const reportCall = state.calls.filter((c) => c.action === "session/report").at(-1);
    assert.equal(reportCall?.body["team_id"], "tem_demo");
    assert.equal(reportCall?.body["session_id"], "sess_face_1");
    const sent = (reportCall?.body["candidates"] as { type: string; layer: string }[])[0]!;
    assert.equal(sent.type, "memory");
    assert.equal(sent.layer, "atom");
  } finally {
    await close();
  }
});

// memory 的分层取值以 data-model.md §8 为准：core | profile | atom。
test("knowledge_save: layer=profile is accepted and reaches asset/create unchanged", async () => {  const { client, state, close } = await connect();
  try {
    const saved = await client.callTool({ name: "knowledge_save", arguments: { title: "值班画像", content: "夜间值班的惯例", layer: "profile" } });
    assert.equal(saved.isError, undefined, textOf(saved));
    assert.deepEqual(JSON.parse(textOf(saved)), { id: "mem_new", version: 1, visibility: "private" });
    assert.equal(state.calls.filter((c) => c.action === "asset/create").at(-1)?.body["layer"], "profile");
  } finally {
    await close();
  }
});

test("knowledge_save: a layer outside core | profile | atom is refused before the hub is called", async () => {
  const { client, state, close } = await connect();
  try {
    const refused = await client.callTool({ name: "knowledge_save", arguments: { title: "值班画像", content: "夜间值班的惯例", layer: "skill" } });
    assert.equal(refused.isError, true);
    assert.equal(state.calls.some((c) => c.action === "asset/create"), false, "an invalid layer must not reach the hub");
  } finally {
    await close();
  }
});

test("T10: brief baseline never calls loadout/resolve", async () => {
  const { client, state, close } = await connect({ baseline: "brief" });
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /^<cinlan_knowledge_brief team="demo" agent="bob-cc">/);
    assert.ok(!state.calls.some((c) => c.action === "loadout/resolve"));
    assert.ok(!state.calls.some((c) => c.action === "usage/report"));
  } finally {
    await client.close();
  }
});

test("T10: the face answers JSON only and rejects GET like a stateless endpoint", async () => {
  const { client, transport, close } = await connect();
  try {
    await client.ping();
  } finally {
    await close();
  }
  // 同一桥接上的非 POST 也不会被吞成 200：face 自己回 405 + JSON-RPC 错误体
  const bridged = await bridge("http://ck.test/mcp", { method: "GET", headers: { "x-ck-session": "missing" } }).catch(
    () => null,
  );
  assert.equal(bridged, null, "unknown session must not be served");

  const face = createMcpFace();
  const session = { rpc: makeRpc({ calls: [], assets: new Map() }), ctx, instructions: async () => LOADOUT_TEXT };
  for (const method of ["GET", "DELETE"]) {
    const res = await face.fetch(new Request("http://ck.test/mcp", { method }), session);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST");
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(res.headers.get("mcp-session-id"), null);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number }; id: null };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32000);
    assert.equal(body.id, null);
  }
  assert.ok(transport instanceof StreamableHTTPClientTransport);
});

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  assert.ok(content.length > 0);
  return content[0]?.text ?? "";
}

// ------------------------------------------------------------------ §5.3：knowledge_status 的 baseline 会话事实

test("knowledge_status: session facts fill digest / current_digest / changed / stale and the skills snapshot", async () => {
  // 会话开始时投递的 digest 与 hub 现算的不同 → changed: true；文本来自缓存 → stale: true
  const sessionDigest = "a".repeat(64);
  const { client, close } = await connect({
    session: { digest: sessionDigest, stale: true, skills: { materialized: 2, conflicts: ["other-team-skill"] } },
  });
  try {
    const out = await client.callTool({ name: "knowledge_status", arguments: {} });
    assert.equal(out.isError, undefined, textOf(out));
    const status = JSON.parse(textOf(out)) as {
      baseline: { delivery: string; digest: string; current_digest: string; changed: boolean; stale: boolean };
      skills: { materialized: number; conflicts: string[] };
    };
    assert.equal(status.baseline.digest, sessionDigest);
    assert.equal(status.baseline.current_digest, "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(status.baseline.changed, true);
    assert.equal(status.baseline.stale, true);
    assert.deepEqual(status.skills, { materialized: 2, conflicts: ["other-team-skill"] });
  } finally {
    await close();
  }
});

test("knowledge_status: A0 (no session facts) → baseline only carries delivery + digest, no skills key", async () => {
  const { client, close } = await connect();
  try {
    const out = await client.callTool({ name: "knowledge_status", arguments: {} });
    assert.equal(out.isError, undefined, textOf(out));
    const status = JSON.parse(textOf(out)) as Record<string, unknown>;
    const baseline = status["baseline"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(baseline).sort(), ["delivery", "digest"]);
    assert.equal(baseline["digest"], "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal("skills" in status, false);
  } finally {
    await close();
  }
});

// O-9 ͨ�� A��ע���� embed ʱ knowledge_search ����ѯ�������˵�ʧ�ܽ����� FTS
test("knowledge_search with injected embed: query_embedding reaches asset/search", async () => {
  const embed: EmbedFn = async (text: string): Promise<number[]> => {
    assert.equal(text, "����");
    return [0.1, 0.2, 0.3, 0.4];
  };
  const { client, state, close } = await connect({ embed });
  try {
    const out = await client.callTool({ name: "knowledge_search", arguments: { query: "����" } });
    assert.equal(out.isError, undefined);
    const call = state.calls.filter((c) => c.action === "asset/search").at(-1);
    assert.deepEqual(call?.body["query_embedding"], [0.1, 0.2, 0.3, 0.4]);
  } finally {
    await close();
  }
});

test("knowledge_search with a broken embed endpoint degrades to pure FTS", async () => {
  const embed: EmbedFn = async (): Promise<number[]> => {
    throw new Error("embeddings endpoint 500: boom");
  };
  const { client, state, close } = await connect({ embed });
  try {
    const out = await client.callTool({ name: "knowledge_search", arguments: { query: "����" } });
    assert.equal(out.isError, undefined, "��������������������ʧ�ܶ�ʧ��");
    const call = state.calls.filter((c) => c.action === "asset/search").at(-1);
    assert.equal("query_embedding" in (call?.body ?? {}), false);
  } finally {
    await close();
  }
});
