import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResolvedConfig } from "../src/config.js";
import { makeEmbedder, runEmbeddingsSync } from "../src/embeddings.js";
import { createCliSession } from "../src/mcp.js";
import { httpHub, resolveData } from "./support.js";

/**
 * `ck embeddings sync`（O-9 通道 A）：真 httpHub 摆差集与写回，另起一个假
 * openai-compatible /embeddings 端点。验证文本拼装、逐条写回、单条失败不拦后续、dry-run。
 */

interface EmbedRequest {
  model: string;
  input: string[];
}

function fakeEmbedder(): Promise<{ url: string; requests: EmbedRequest[]; failNext: () => void; close: () => Promise<void> }> {
  const requests: EmbedRequest[] = [];
  let fail = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmbedRequest;
      requests.push(body);
      if (fail) {
        fail = false;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        failNext: () => {
          fail = true;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function cfg(hub: string): ResolvedConfig {
  return { hub, key: "ck_k", sources: { hub: "env", key: "env" } };
}

test("embeddings sync: pulls pending, embeds title+summary+content, writes vectors back", async () => {
  const hub = await httpHub((action, body) => {
    if (action === "embedding/pending") {
      return {
        data: {
          items: [
            { asset_id: "ast_1", version: 2, title: "值班响应约定", type: "memory", visibility: "team", updated_at: "2026-01-01T00:00:00.000Z" },
            { asset_id: "ast_2", version: 1, title: "发版检查清单", type: "memory", visibility: "team", updated_at: "2026-01-01T00:00:00.000Z" },
          ],
        },
      };
    }
    if (action === "asset/get") {
      const id = body["asset_id"] as string;
      return {
        data: {
          asset: { id, title: id === "ast_1" ? "值班响应约定" : "发版检查清单", summary: id === "ast_1" ? "十分钟内响应" : "" },
          version: { version: id === "ast_1" ? 2 : 1, content: id === "ast_1" ? "夜间 P0 告警先看日志。" : "发布前跑全部测试。" },
        },
      };
    }
    if (action === "embedding/put") {
      return { data: { written: 1 } };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
  const embedder = await fakeEmbedder();
  try {
    const report = await runEmbeddingsSync({
      config: cfg(hub.url),
      url: embedder.url,
      model: "fake-mini",
      apiKey: "sk-test",
    });
    assert.equal(report.ok, true);
    assert.equal(report.embedded, 2);
    assert.equal(report.failed, 0);

    // 文本拼装：标题 + 摘要 + 正文都进了 embedding 的 input
    assert.equal(embedder.requests.length, 2);
    assert.match(embedder.requests[0]!.input[0]!, /值班响应约定/);
    assert.match(embedder.requests[0]!.input[0]!, /十分钟内响应/);
    assert.match(embedder.requests[0]!.input[0]!, /夜间 P0 告警先看日志/);

    // 写回：asset_id / version / model / 向量
    const puts = hub.calls.filter((c) => c.action === "embedding/put");
    assert.equal(puts.length, 2);
    assert.equal(puts[0]!.body["asset_id"], "ast_1");
    assert.equal(puts[0]!.body["version"], 2);
    assert.equal(puts[0]!.body["model"], "fake-mini");
    assert.deepEqual(puts[0]!.body["vectors"], [[0.1, 0.2, 0.3, 0.4]]);
  } finally {
    await embedder.close();
    await hub.close();
  }
});

test("embeddings sync: a failed asset is recorded and the rest continue; exit reflects failures", async () => {
  const hub = await httpHub((action, body) => {
    if (action === "embedding/pending") {
      return {
        data: {
          items: [
            { asset_id: "ast_bad", version: 1, title: "坏条目", type: "memory", visibility: "team", updated_at: "2026-01-01T00:00:00.000Z" },
            { asset_id: "ast_ok", version: 1, title: "好条目", type: "memory", visibility: "team", updated_at: "2026-01-01T00:00:00.000Z" },
          ],
        },
      };
    }
    if (action === "asset/get") {
      return {
        data: {
          asset: { id: body["asset_id"] as string, title: "t" },
          version: { version: 1, content: "c" },
        },
      };
    }
    if (action === "embedding/put") {
      if (body["asset_id"] === "ast_bad") return { code: 400, message: "INVALID_ARGUMENT", data: { detail: "dims mismatch" } };
      return { data: { written: 1 } };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
  const embedder = await fakeEmbedder();
  try {
    const report = await runEmbeddingsSync({ config: cfg(hub.url), url: embedder.url, model: "fake-mini" });
    assert.equal(report.ok, false);
    assert.equal(report.embedded, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.failures[0]!.asset_id, "ast_bad");
    assert.match(report.failures[0]!.reason, /INVALID_ARGUMENT|dims/);
  } finally {
    await embedder.close();
    await hub.close();
  }
});

test("embeddings sync: embed endpoint failure lands in failures, not a crash", async () => {
  const hub = await httpHub((action) => {
    if (action === "embedding/pending") {
      return { data: { items: [{ asset_id: "ast_1", version: 1, title: "t", type: "memory", visibility: "team", updated_at: "2026-01-01T00:00:00.000Z" }] } };
    }
    if (action === "asset/get") {
      return { data: { asset: { id: "ast_1", title: "t" }, version: { version: 1, content: "c" } } };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
  const embedder = await fakeEmbedder();
  embedder.failNext();
  try {
    const report = await runEmbeddingsSync({ config: cfg(hub.url), url: embedder.url, model: "fake-mini" });
    assert.equal(report.failed, 1);
    assert.match(report.failures[0]!.reason, /embeddings endpoint 500/);
    assert.equal(hub.calls.filter((c) => c.action === "embedding/put").length, 0, "no put after a failed embed");
  } finally {
    await embedder.close();
    await hub.close();
  }
});

test("embeddings sync: --dry-run embeds but writes nothing back", async () => {
  const hub = await httpHub((action) => {
    if (action === "embedding/pending") {
      return { data: { items: [{ asset_id: "ast_1", version: 1, title: "t", type: "memory", visibility: "team", updated_at: "2026-01-01T00:00:00.000Z" }] } };
    }
    if (action === "asset/get") {
      return { data: { asset: { id: "ast_1", title: "t" }, version: { version: 1, content: "c" } } };
    }
    return { code: 404, message: "NOT_FOUND" };
  });
  const embedder = await fakeEmbedder();
  try {
    const report = await runEmbeddingsSync({ config: cfg(hub.url), url: embedder.url, model: "fake-mini", dryRun: true });
    assert.equal(report.embedded, 1);
    // dry-run 全程只读：模型端点也不调（省额度），更不写回
    assert.equal(embedder.requests.length, 0);
    assert.equal(hub.calls.filter((c) => c.action === "embedding/put").length, 0);
  } finally {
    await embedder.close();
    await hub.close();
  }
});

test("makeEmbedder: only wired when both CK_EMBED_URL and CK_EMBED_MODEL are set; hits the endpoint", async () => {
  assert.equal(makeEmbedder({}), undefined);
  assert.equal(makeEmbedder({ CK_EMBED_URL: "http://x" }), undefined);
  assert.equal(makeEmbedder({ CK_EMBED_MODEL: "m" }), undefined);
  const embedder = await fakeEmbedder();
  try {
    const embed = makeEmbedder({ CK_EMBED_URL: embedder.url, CK_EMBED_MODEL: "fake-mini", CK_EMBED_KEY: "sk" });
    assert.ok(embed !== undefined);
    assert.deepEqual(await embed("��ѯ�ı�"), [0.1, 0.2, 0.3, 0.4]);
    assert.equal(embedder.requests.length, 1);
    assert.equal(embedder.requests[0]!.model, "fake-mini");
    assert.equal(embedder.requests[0]!.input[0], "��ѯ�ı�");
  } finally {
    await embedder.close();
  }
});

test("createCliSession injects embed into the MCP face session (O-9 channel A)", async () => {
  const hub = await httpHub((action) => {
    if (action === "agent/ensure") return { data: { agent: { id: "ag_1", team_id: "tem_1" } } };
    if (action === "loadout/resolve") return { data: resolveData("��װ") };
    return { code: 404, message: "NOT_FOUND" };
  });
  const embedder = await fakeEmbedder();
  try {
    const session = await createCliSession({
      config: cfg(hub.url),
      host: host(),
      agent: { team: "core", name: "builder" },
      embed: async (text: string): Promise<number[]> => {
        assert.equal(text, "��ѯ");
        return [1, 0, 0, 0];
      },
    });
    assert.ok(session.session.embed !== undefined);
    assert.deepEqual(await session.session.embed!("��ѯ"), [1, 0, 0, 0]);
    assert.equal(embedder.requests.length, 0, "��ʽ embed ����ʱ��ȥ�������˵�");
    await session.background;
  } finally {
    await embedder.close();
    await hub.close();
  }
});

function host(): Parameters<typeof createCliSession>[0]["host"] {
  return {
    name: "claude-code",
    title: "Claude Code",
    skill_dir: "~/.claude/skills",
    mcp: { file: "", format: "json", key: "mcpServers.ck", insert: false },
    hook: null,
    instructions: "full",
    budgets: {},
  };
}
