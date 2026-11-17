import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildGuide, CK_ENTRY, fillPlaceholders, groupGuide, type GuideContext, type HostBundle } from "../src/lib/guide.js";

const CTX: GuideContext = { hubUrl: "http://hub.local:8424", team: "core", agentName: "cc-ly" };

/** 真实声明与模板：跑构建脚本取同源 JSON，避免测试里手抄一份。 */
function realBundle(): HostBundle {
  const out = execFileSync(process.execPath, ["scripts/build-hosts.mjs", "--stdout"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(out) as HostBundle;
}

test("矩阵顺序固定，未落地宿主不给片段", () => {
  const cards = buildGuide({ hosts: [] }, CTX);
  assert.deepEqual(
    cards.map((c) => c.host),
    ["dsh", "cinlan-harness", "claude-code", "codex", "gemini-cli", "opencode", "hermes", "generic"],
  );
  const byName = new Map(cards.map((c) => [c.host, c]));
  for (const host of ["gemini-cli", "opencode"]) {
    // bundle 空时 ready 宿主也只出空卡（组按 roster，不给片段）
    assert.equal(byName.get(host)!.group, "ready");
    assert.equal(byName.get(host)!.setupCommand, null);
    assert.equal(byName.get(host)!.snippets.length, 0);
  }
  const generic = byName.get("generic")!;
  assert.equal(generic.snippets.length, 1);
  assert.match(generic.snippets[0]!.content, /Bearer <your-user-key>/);
  assert.match(generic.snippets[0]!.content, /http:\/\/hub\.local:8424\/mcp/);
});

test("真实模板：七个已适配宿主为 ready，build 命令与声明一致", () => {
  const cards = buildGuide(realBundle(), CTX);
  const byName = new Map(cards.map((c) => [c.host, c]));
  for (const host of ["dsh", "cinlan-harness", "claude-code", "codex", "gemini-cli", "hermes", "opencode"]) {
    const card = byName.get(host)!;
    assert.equal(card.group, "ready");
    assert.equal(card.setupCommand, `ck setup --host ${host} --agent core/cc-ly`);
    assert.ok(card.snippets.length >= 1);
  }
  assert.deepEqual(
    byName.get("claude-code")!.snippets.map((s) => s.file).sort(),
    ["hook.session-start.json", "mcp.http.json", "mcp.json"],
  );
});

test("片段里不留占位符，也不出现真 key", () => {
  const cards = buildGuide(realBundle(), CTX);
  for (const card of cards.filter((c) => c.group === "ready" && c.host !== "generic")) {
    for (const snippet of card.snippets) {
      assert.ok(!snippet.content.includes("{{"), `${card.host}/${snippet.file} 残留占位符`);
      assert.ok(!/\bck_[A-Za-z0-9]{8,}/.test(snippet.content), `${card.host}/${snippet.file} 出现疑似真 key`);
    }
  }
});

test("JSON 模板展开到落点：去掉 _comment，换成可解析的片段", () => {
  const card = buildGuide(realBundle(), CTX).find((c) => c.host === "claude-code")!;
  const mcp = card.snippets.find((s) => s.file === "mcp.json")!;
  assert.equal(mcp.target, "~/.claude.json → mcpServers.ck");
  assert.ok(mcp.comment.includes("stdio"));
  const parsed = JSON.parse(mcp.content) as { command: string; args: string[] };
  assert.equal(parsed.command, "node");
  assert.equal(parsed.args[0], CK_ENTRY);
  assert.ok(parsed.args.includes("core/cc-ly"));
  assert.ok(!mcp.content.includes("_comment"));

  const http = card.snippets.find((s) => s.file === "mcp.http.json")!;
  const httpParsed = JSON.parse(http.content) as { url: string; headers: Record<string, string> };
  assert.equal(httpParsed.url, "http://hub.local:8424/mcp");
  assert.equal(httpParsed.headers["x-ck-agent"], "core/cc-ly");

  const hook = card.snippets.find((s) => s.file === "hook.session-start.json")!;
  assert.equal(hook.target, "~/.claude/settings.json → hooks.SessionStart");
  assert.ok(hook.content.includes("hook session-start --host claude-code"));
});

test("YAML 模板去掉注释行，占位符全部替换", () => {
  const card = buildGuide(realBundle(), CTX).find((c) => c.host === "dsh")!;
  const stdio = card.snippets.find((s) => s.file === "mcp.patch.yml")!;
  assert.ok(!stdio.content.split("\n").some((line) => line.trimStart().startsWith("#")));
  assert.ok(stdio.content.includes("'--baseline', 'full'"));
  assert.ok(stdio.content.includes("'core/cc-ly'"));
  assert.ok(stdio.comment.includes("cordis.patch.yml"));
});

test("占位符替换规则", () => {
  assert.equal(
    fillPlaceholders("{{HUB_URL}}|{{CK_ENTRY}}|{{AGENT}}|{{UNKNOWN}}", CTX),
    `http://hub.local:8424|${CK_ENTRY}|core/cc-ly|{{UNKNOWN}}`,
  );
});

test("分组：空组不渲染，标签按文档", () => {
  const groups = groupGuide(buildGuide(realBundle(), CTX));
  assert.deepEqual(
    groups.map((g) => [g.group, g.label, g.cards.length]),
    [["ready", "已适配", 8]],
  );
});
