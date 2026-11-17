import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { hostConfig } from "../src/hosts.js";
import {
  hookEntry,
  mcpEntry,
  renderTomlBlock,
  renderYamlBlock,
  renderYamlHookItem,
  renderYamlMcpEntry,
  type SetupOptions,
} from "../src/setup.js";

/**
 * 宿主模板一致性（docs/hosts.md §6）：`agents/<host>/templates/` 必须与 `ck setup` 生成的条目一致。
 * 模板是手工接入手册的抄写来源；抄出来的东西与工具输出的不一致，按 bug 处理。
 */

/** 仓库根 `agents/`（测试从 packages/cli 跑，`node --test` 的 cwd 是包目录）。 */
const AGENTS = join(process.cwd(), "..", "..", "agents");
const CK = "/opt/ck/lib/bin.js";
const HUB = "http://hub.local:8424";
const AGENT = { team: "core", name: "ly" } as const;

function readTemplate(host: string, file: string): string {
  return readFileSync(join(AGENTS, host, "templates", file), "utf8");
}

/** 占位符替换：模板里的值带引号，替换后仍带引号。 */
function fill(text: string): string {
  return text
    .replaceAll("'{{CK_ENTRY}}'", `'${CK}'`)
    .replaceAll('"{{CK_ENTRY}}"', `"${CK}"`)
    .replaceAll("{{CK_ENTRY}}", CK)
    .replaceAll("'{{HUB_URL}}'", `'${HUB}'`)
    .replaceAll("{{HUB_URL}}", HUB)
    .replaceAll("{{AGENT}}", `${AGENT.team}/${AGENT.name}`);
}

/** 去掉注释行与块标记，只留 YAML 条目本体。 */
function yamlBody(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}

function options(host: string, overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    host: hostConfig(host, { CK_AGENTS_DIR: AGENTS }),
    agent: AGENT,
    transport: "stdio",
    ckEntry: CK,
    hubUrl: HUB,
    rules: false,
    ...overrides,
  };
}

/** 读 JSON 模板并去掉说明字段；返回根对象与用于取键的路径。 */
function jsonTemplate(host: string, file: string, keyPath: string): unknown {
  const parsed = JSON.parse(readTemplate(host, file)) as Record<string, unknown>;
  delete parsed["_comment"];
  let node: unknown = parsed;
  for (const part of keyPath.split(".")) node = (node as Record<string, unknown>)[part];
  return node;
}

// ------------------------------------------------------------ dsh 系 YAML

for (const host of ["dsh", "cinlan-harness"] as const) {
  test(`${host} / stdio 模板与 renderYamlBlock 一致`, () => {
    const block = renderYamlBlock(options(host));
    const body = block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
    assert.equal(yamlBody(fill(readTemplate(host, "mcp.patch.yml"))), body);
  });

  test(`${host} / http 模板与 renderYamlBlock 一致`, () => {
    const block = renderYamlBlock(options(host, { transport: "http" }));
    const body = block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
    assert.equal(yamlBody(fill(readTemplate(host, "mcp.http.patch.yml"))), body);
  });
}

// ------------------------------------------------------------ claude-code JSON

test("claude-code / stdio MCP 模板与 mcpEntry 一致", () => {
  const filled = fill(readTemplate("claude-code", "mcp.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  assert.deepEqual(parsed["mcpServers.ck"], mcpEntry(options("claude-code")));
});

test("claude-code / http MCP 模板与 mcpEntry 一致", () => {
  const filled = fill(readTemplate("claude-code", "mcp.http.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  assert.deepEqual(parsed["mcpServers.ck"], mcpEntry(options("claude-code", { transport: "http" })));
});

test("claude-code / hook 模板与 hookEntry 一致", () => {
  const filled = fill(readTemplate("claude-code", "hook.session-start.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  const entries = parsed["hooks.SessionStart"] as unknown[];
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], hookEntry(options("claude-code")));
});

// ------------------------------------------------------------ codex TOML

/** 去掉注释行与块标记，只留 TOML 条目本体。 */
const tomlBody = yamlBody;

test("codex / stdio 模板与 renderTomlBlock 一致", () => {
  const block = renderTomlBlock(options("codex"));
  const body = block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
  assert.equal(tomlBody(fill(readTemplate("codex", "mcp.toml"))), body);
});

test("codex / http 模板与 renderTomlBlock 一致", () => {
  const block = renderTomlBlock(options("codex", { transport: "http" }));
  const body = block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
  assert.equal(tomlBody(fill(readTemplate("codex", "mcp.http.toml"))), body);
});

test("codex / hook 模板与 hookEntry 一致", () => {
  const filled = fill(readTemplate("codex", "hooks.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  const entries = parsed["hooks.SessionStart"] as unknown[];
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], hookEntry(options("codex")));
});

// ------------------------------------------------------------ gemini-cli JSON

test("gemini-cli / stdio MCP 模板与 mcpEntry 一致", () => {
  const filled = fill(readTemplate("gemini-cli", "mcp.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  assert.deepEqual(parsed["mcpServers.ck"], mcpEntry(options("gemini-cli")));
});

test("gemini-cli / http MCP 模板与 mcpEntry 一致", () => {
  const filled = fill(readTemplate("gemini-cli", "mcp.http.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  assert.deepEqual(parsed["mcpServers.ck"], mcpEntry(options("gemini-cli", { transport: "http" })));
});

test("gemini-cli / hook 模板与 hookEntry 一致（timeout 毫秒 + name 禁用键）", () => {
  const filled = fill(readTemplate("gemini-cli", "hooks.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  const entries = parsed["hooks.SessionStart"] as unknown[];
  assert.equal(entries.length, 1);
  const want = hookEntry(options("gemini-cli"));
  assert.deepEqual(entries[0], want);
  const handler = (want as { hooks: Record<string, unknown>[] }).hooks[0]!;
  assert.equal(handler["name"], "cinlan-knowledge");
  assert.equal(handler["timeout"], 15000);
});

// ------------------------------------------------------------ hermes YAML（嵌套键，非标记块）

test("hermes / stdio 模板与 renderYamlMcpEntry 一致", () => {
  // 模板含 mcp_servers: 父行；去注释后抷掉第一行，其余行减一层缩进后与条目相对缩进一致
  const body = yamlBody(fill(readTemplate("hermes", "mcp.yaml")))
    .split("\n")
    .slice(1)
    .map((l) => l.slice(2));
  assert.deepEqual(body, renderYamlMcpEntry(options("hermes")));
});

test("hermes / http 模板与 renderYamlMcpEntry 一致", () => {
  const body = yamlBody(fill(readTemplate("hermes", "mcp.http.yaml")))
    .split("\n")
    .slice(1)
    .map((l) => l.slice(2));
  assert.deepEqual(body, renderYamlMcpEntry(options("hermes", { transport: "http" })));
});

test("hermes / hook 模板与 renderYamlHookItem 一致", () => {
  // 模板含 hooks: 与 pre_llm_call: 两行父层；抷掉后减两层缩进
  const body = yamlBody(fill(readTemplate("hermes", "hook.yaml")))
    .split("\n")
    .slice(2)
    .map((l) => l.slice(4));
  assert.deepEqual(body, renderYamlHookItem(options("hermes")));
});

// ------------------------------------------------------------ opencode JSON（argv 数组）

test("opencode / stdio 模板与 mcpEntry 一致（type:local + argv command）", () => {
  const filled = fill(readTemplate("opencode", "mcp.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  const want = mcpEntry(options("opencode"));
  assert.deepEqual(parsed["mcp.ck"], want);
  // argv 形状钉死：type:local + 整条 argv，无 args 分写
  assert.deepEqual(want, {
    type: "local",
    command: ["node", CK, "mcp", "--host", "opencode", "--agent", "core/ly"],
  });
});

test("opencode / http 模板与 mcpEntry 一致（type:remote）", () => {
  const filled = fill(readTemplate("opencode", "mcp.http.json"));
  const parsed = JSON.parse(filled) as Record<string, unknown>;
  delete parsed["_comment"];
  const want = mcpEntry(options("opencode", { transport: "http" }));
  assert.deepEqual(parsed["mcp.ck"], want);
  assert.equal((want as { type: string }).type, "remote");
});

// ------------------------------------------------------------ 声明与内置表

test("七份 host.json 与内置表不冲突（声明即内置表的等价副本）", () => {
  for (const host of ["dsh", "cinlan-harness", "claude-code", "codex", "gemini-cli", "hermes", "opencode"]) {
    const declared = hostConfig(host, { CK_AGENTS_DIR: AGENTS });
    const builtin = hostConfig(host, { CK_AGENTS_DIR: join(AGENTS, "__none__") });
    for (const field of ["name", "title", "instructions", "skill_dir", "rules_file", "import_scan", "platforms"] as const) {
      assert.deepEqual(declared[field], builtin[field], `${host}.${field}`);
    }
    assert.deepEqual(declared.mcp, builtin.mcp, `${host}.mcp`);
    assert.deepEqual(declared.hook, builtin.hook, `${host}.hook`);
    assert.deepEqual(declared.budgets, builtin.budgets, `${host}.budgets`);
  }
});
