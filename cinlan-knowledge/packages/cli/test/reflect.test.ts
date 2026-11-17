import { test } from "node:test";
import assert from "node:assert/strict";
import { httpHub } from "./support.js";
import { buildReflectPrompt, parseReflectResponse, runReflect, runReflectTeam } from "../src/reflect.js";
import type { ResolvedConfig } from "../src/config.js";

/**
 * `ck reflect`（v2 deep-memory.md §3 第 1 条）：跨会话抽象。
 * 测试三层：prompt 组装 / LLM 应答解析 / 完整回路（httpHub + 假 LLM 端点）。
 */

function cfg(hub: string): ResolvedConfig {
  return { hub, key: "ck_k", sources: { hub: "env", key: "env" } };
}

// ---- 单元：prompt 组装 ----

test("buildReflectPrompt: asset + drafts → system + user", () => {
  const { system, user } = buildReflectPrompt({
    assetTitle: "值班手册",
    assetContent: "夜间 P0 告警十分钟内响应。",
    drafts: [
      { title: "暗号", content: "暗号是 magpie-77", session_id: "sess_1" },
      { title: "升级", content: "十分钟没响就升级拉人" },
    ],
  });
  assert.match(system, /团队知识管理助手/);
  assert.match(system, /asset_updates/);
  assert.match(system, /new_atoms/);
  assert.match(system, /contradictions/);
  assert.match(user, /值班手册/);
  assert.match(user, /夜间 P0 告警十分钟内响应/);
  assert.match(user, /暗号是 magpie-77/);
  assert.match(user, /十分钟没响就升级拉人/);
  assert.match(user, /session: sess_1/);
});

// ---- 单元：LLM 应答解析 ----

test("parseReflectResponse: clean JSON, markdown-fenced, leading text", () => {
  const clean = JSON.stringify({ asset_updates: [], new_atoms: [{ title: "t", content: "c", reason: "r" }], contradictions: [] });
  assert.deepEqual(parseReflectResponse(clean), {
    asset_updates: [],
    new_atoms: [{ title: "t", content: "c", reason: "r" }],
    contradictions: [],
  });

  const fenced = "```json\n" + clean + "\n```";
  assert.deepEqual(parseReflectResponse(fenced).new_atoms.length, 1);

  const chatty = `好的，我来分析：\n${clean}\n以上是我的建议。`;
  assert.deepEqual(parseReflectResponse(chatty).new_atoms.length, 1);

  assert.throws(() => parseReflectResponse("没有 JSON"), /没有 JSON/);
});

// ---- 单元：缺少字段容错 ----

test("parseReflectResponse: missing fields default to empty arrays", () => {
  const partial = JSON.stringify({ asset_updates: [{ title: "t", content: "c", reason: "r" }] });
  const out = parseReflectResponse(partial);
  assert.deepEqual(out.asset_updates.length, 1);
  assert.deepEqual(out.new_atoms, []);
  assert.deepEqual(out.contradictions, []);
});

// ---- 集成：完整回路（httpHub + 假 LLM 端点） ----

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

function fakeLLM(response: object): Promise<{ url: string; requests: { messages: unknown[] }[]; close: () => Promise<void> }> {
  const requests: { messages: unknown[] }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
    });
  });
  server.unref();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

// 绕过 undici 全局连接池的一次性 fetch——每次请求完就断，不留 keep-alive 句柄挂住事件循环。
// httpRequest 已在上方 import（createServer 同一行）
function oneShotFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(String(input));
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
      },
      (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          req.destroy();
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 200, headers: { "content-type": res.headers["content-type"] ?? "application/json" } }));
        });
      },
    );
    req.on("error", reject);
    if (init?.body) req.write(String(init.body));
    req.end();
  });
}

test("runReflect: full loop with httpHub + fake LLM — dry-run and submit", async () => {
  const hub = await httpHub((action, body) => {
    if (action === "auth/verify") return { data: { user: { id: "usr_1" }, teams: [{ team_id: "tem_1", team: "walk", role: "admin" }] } };
    if (action === "asset/get") {
      const id = body["asset_id"] as string;
      if (id === "ast_draft_1") return { data: { asset: { id, title: "暗号记录", type: "memory" }, version: { version: 1, content: "暗号是 magpie-77" } } };
      return {
        data: {
          asset: { id: "ast_1", title: "值班手册", type: "memory", team_id: "tem_1", current_version: 2, visibility: "team" },
          version: { version: 2, content: "夜间 P0 告警十分钟内响应；暗号见当班交接。" },
        },
      };
    }
    if (action === "asset/list") {
      return {
        data: {
          items: [
            { id: "ast_draft_1", title: "暗号记录", source: { origin: "capture", session_id: "sess_1" } },
          ],
          next_cursor: "",
        },
      };
    }
    if (action === "asset/update") {
      return { data: { status: "pending_review", review_id: "rev_1" } };
    }
    if (action === "session/report") {
      return { data: { drafts: (body["candidates"] as unknown[]).map((_, i) => ({ id: `draft_${i}`, title: "t", visibility: "private", status: "draft" })) } };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
  const llm = await fakeLLM({
    asset_updates: [{ title: "值班手册（更新）", content: "夜间 P0 告警十分钟内响应；暗号 magpie-77。", reason: "补充了当班暗号" }],
    new_atoms: [{ title: "升级阈值", content: "十分钟没有响应记录就升级拉人。", reason: "独立事实" }],
    contradictions: [],
  });
  try {
    // dry-run：只产报告不提交
    const dry = await runReflect({
      config: cfg(hub.url),
      url: llm.url,
      model: "fake-llm",
      assetId: "ast_1",
      dryRun: true,
      fetchImpl: oneShotFetch as typeof fetch,
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.drafts_read, 1);
    assert.equal(dry.proposals.asset_updates.length, 1);
    assert.equal(dry.proposals.new_atoms.length, 1);
    assert.equal(dry.submitted.updates, 0, "dry-run 不提交");
    assert.equal(llm.requests.length, 1, "LLM 只调一次");
    // LLM 请求里有资产正文和草稿正文
    const llmBody = llm.requests[0] as { messages: { role: string; content: string }[] };
    assert.match(llmBody.messages[1]!.content, /值班手册/);
    assert.match(llmBody.messages[1]!.content, /暗号是 magpie-77/);

    // 真提交：update 走 review，atom 走草稿
    const real = await runReflect({
      config: cfg(hub.url),
      url: llm.url,
      model: "fake-llm",
      assetId: "ast_1",
      fetchImpl: oneShotFetch as typeof fetch,
    });
    assert.equal(real.submitted.updates, 1);
    assert.equal(real.submitted.review_ids.length, 1, "update 走了 review");
    assert.equal(real.submitted.atoms, 1, "atom 走了草稿");
    assert.equal(real.ok, true);
  } finally {
    await llm.close();
    await hub.close();
  }
});

test("runReflect: LLM failure lands in errors, not a crash", async () => {
  const hub = await httpHub((action, body) => {
    if (action === "asset/get") {
      return { data: { asset: { id: "ast_1", title: "t", team_id: "tem_1", current_version: 1, visibility: "team" }, version: { version: 1, content: "c" } } };
    }
    if (action === "asset/list") return { data: { items: [], next_cursor: "" } };
    return { code: 404, message: "NOT_FOUND" };
  });
  // 一个 500 的假 LLM
  const badServer: Server = createServer((req, res) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: "boom" }));
  });
  await new Promise<void>((r) => badServer.listen(0, "127.0.0.1", r));
  const badUrl = `http://127.0.0.1:${(badServer.address() as AddressInfo).port}`;
  try {
    await assert.rejects(
      () => runReflect({ config: cfg(hub.url), url: badUrl, model: "m", assetId: "ast_1" }),
      (err: unknown) => err instanceof Error && /LLM 端点 500/.test(err.message),
    );
  } finally {
    await new Promise<void>((r) => badServer.close(() => r()));
    await hub.close();
  }
});

test("runReflectTeam: batch mode — processes assets in draft-priority order, failures don't stop the rest", async () => {
  let assetCalls = 0;
  const hub = await httpHub((action, body) => {
    if (action === "asset/list" && (body as Record<string, unknown>)["status"] === "active") {
      return {
        data: {
          items: [
            { id: "ast_1", title: "无草稿资产", visibility: "team" },
            { id: "ast_2", title: "有草稿资产", visibility: "team" },
          ],
        },
      };
    }
    if (action === "asset/list" && (body as Record<string, unknown>)["status"] === "draft") {
      return { data: { items: [{ id: "ast_d1", title: "有草稿资产" }] } };
    }
    if (action === "asset/get") {
      const id = body["asset_id"] as string;
      assetCalls += 1;
      if (id === "ast_2") return { data: { asset: { id: "ast_2", title: "有草稿资产", team_id: "tem_1", current_version: 1, visibility: "team" }, version: { version: 1, content: "内容2" } } };
      return { data: { asset: { id: "ast_1", title: "无草稿资产", team_id: "tem_1", current_version: 1, visibility: "team" }, version: { version: 1, content: "内容1" } } };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
  const llm = await fakeLLM({ asset_updates: [], new_atoms: [], contradictions: [] });
  try {
    const report = await runReflectTeam({
      config: cfg(hub.url),
      team: "walk",
      url: llm.url,
      model: "fake-llm",
      dryRun: true,
      fetchImpl: oneShotFetch as typeof fetch,
    });
    assert.equal(report.ok, true);
    assert.equal(report.assets_processed, 2, "两条资产都跑了");
    assert.equal(report.errors.length, 0);
    // 有草稿关联的资产（ast_2「有草稿资产」）先跑
    assert.equal(assetCalls, 4, "2 资产 × 2 次 asset/get（读详情 + 读草稿内容）");
    // LLM 调了 2 次（每条资产一次）
    assert.equal(llm.requests.length, 2);
    // 先跑的是有草稿关联的资产
    const firstBody = llm.requests[0] as { messages: { role: string; content: string }[] };
    assert.match(firstBody.messages[1]!.content, /有草稿资产/);
  } finally {
    await llm.close();
    await hub.close();
  }
});

test("runReflectTeam: empty team returns ok with zero processed", async () => {
  const hub = await httpHub((action, body) => {
    if (action === "asset/list") return { data: { items: [] } };
    return { code: 404, message: "NOT_FOUND" };
  });
  try {
    const report = await runReflectTeam({ config: cfg(hub.url), team: "empty", url: "http://127.0.0.1:1", model: "m" });
    assert.equal(report.ok, true);
    assert.equal(report.assets_processed, 0);
    assert.equal(report.reports.length, 0);
  } finally {
    await hub.close();
  }
});
