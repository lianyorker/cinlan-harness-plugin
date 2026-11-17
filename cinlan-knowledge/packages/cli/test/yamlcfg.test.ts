import assert from "node:assert/strict";
import test from "node:test";
import { mergeYamlListEntry, mergeYamlMapEntry, yamlChildBlock } from "../src/yamlcfg.js";

/**
 * 嵌套键 YAML 合并（hermes config.yaml 用）——行级手术、不解析 YAML。
 * 覆盖：建段、段尾并入、幂等 unchanged、异形报 conflict、内联空容器改写。
 */

const CK_ENTRY = ["ck:", "  command: node", "  args: ['/ck/bin.js', 'mcp']"];
const HOOK_ITEM = ["- command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'", "  timeout: 15"];
const MARKER = "hook pre-llm-call";

// ------------------------------------------------------------ mergeYamlMapEntry

test("map / 空文件：建顶层段与条目", () => {
  const m = mergeYamlMapEntry("", "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(m.text, "mcp_servers:\n  ck:\n    command: node\n    args: ['/ck/bin.js', 'mcp']");
});

test("map / 已有顶层段：段尾并入，其他键原样保留", () => {
  const before = ["model: kimi", "mcp_servers:", "  other:", "    command: x", "  # 说明", "theme: dark"].join("\n");
  const m = mergeYamlMapEntry(before, "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(
    m.text,
    ["model: kimi", "mcp_servers:", "  other:", "    command: x", "  ck:", "    command: node", "    args: ['/ck/bin.js', 'mcp']", "  # 说明", "theme: dark"].join("\n"),
  );
});

test("map / 同名同内容：unchanged（相对缩进归一化后等价）", () => {
  const before = "mcp_servers:\n    ck:\n      command: node\n      args: ['/ck/bin.js', 'mcp']\n";
  const m = mergeYamlMapEntry(before, "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "unchanged");
});

test("map / 同名不同内容：conflict，不覆盖", () => {
  const before = "mcp_servers:\n  ck:\n    command: python\n";
  const m = mergeYamlMapEntry(before, "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "conflict");
  if (m.status === "conflict") assert.match(m.detail, /mcp_servers\.ck/);
});

test("map / 顶层段是列表：conflict", () => {
  const m = mergeYamlMapEntry("mcp_servers:\n  - a\n", "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "conflict");
});

test("map / 顶层段非空内联值：conflict", () => {
  const m = mergeYamlMapEntry("mcp_servers: {ck: {command: x}}\n", "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "conflict");
});

test("map / `mcp_servers: {}` 内联空容器：改回块头再铺条目", () => {
  const m = mergeYamlMapEntry("mcp_servers: {}\n", "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(m.text, "mcp_servers:\n  ck:\n    command: node\n    args: ['/ck/bin.js', 'mcp']\n");
});

test("map / `ck: {}` 内联空条目：整块换成我们的", () => {
  const before = "mcp_servers:\n  ck: {}\n";
  const m = mergeYamlMapEntry(before, "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(m.text, "mcp_servers:\n  ck:\n    command: node\n    args: ['/ck/bin.js', 'mcp']");
});

test("map / 段尾注释算下一段的：条目插在注释前", () => {
  const before = "mcp_servers:\n  other: 1\n\n  # next section note\ntheme: dark\n";
  const m = mergeYamlMapEntry(before, "mcp_servers", "ck", CK_ENTRY);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  const lines = m.text.split("\n");
  const ckIdx = lines.findIndex((l) => l.trimStart() === "ck:");
  const noteIdx = lines.findIndex((l) => l.trimStart() === "# next section note");
  assert.ok(ckIdx >= 0 && ckIdx < noteIdx, `ck at ${ckIdx}, note at ${noteIdx}`);
});

// ------------------------------------------------------------ mergeYamlListEntry

test("list / 空文件：建 top + child + 条目", () => {
  const m = mergeYamlListEntry("", "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(
    m.text,
    "hooks:\n  pre_llm_call:\n    - command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'\n      timeout: 15",
  );
});

test("list / 已有 hooks 段无 pre_llm_call：段尾补 child + 条目", () => {
  const before = "hooks:\n  on_session_start:\n    - command: 'x'\n";
  const m = mergeYamlListEntry(before, "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(
    m.text,
    "hooks:\n  on_session_start:\n    - command: 'x'\n  pre_llm_call:\n    - command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'\n      timeout: 15\n",
  );
});

test("list / 已有他条：追加到 child 块尾", () => {
  const before = [
    "hooks:",
    "  pre_llm_call:",
    "    - command: 'someone-elses'",
    "      timeout: 5",
  ].join("\n");
  const m = mergeYamlListEntry(before, "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(
    m.text,
    [
      "hooks:",
      "  pre_llm_call:",
      "    - command: 'someone-elses'",
      "      timeout: 5",
      "    - command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'",
      "      timeout: 15",
    ].join("\n"),
  );
});

test("list / 已有我们的条目且同内容：unchanged", () => {
  const before = [
    "hooks:",
    "  pre_llm_call:",
    "    - command: 'someone-elses'",
    "    - command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'",
    "      timeout: 15",
  ].join("\n");
  const m = mergeYamlListEntry(before, "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "unchanged");
});

test("list / 已有我们的条目但内容不同：conflict，列出两边", () => {
  const before = [
    "hooks:",
    "  pre_llm_call:",
    "    - command: 'node \"/old/bin.js\" hook pre-llm-call --host hermes'",
    "      timeout: 5",
  ].join("\n");
  const m = mergeYamlListEntry(before, "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "conflict");
  if (m.status === "conflict") assert.match(m.detail, /pre_llm_call/);
});

test("list / `pre_llm_call: []` 内联空列表：改回块头铺条目", () => {
  const m = mergeYamlListEntry("hooks:\n  pre_llm_call: []\n", "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  assert.equal(
    m.text,
    "hooks:\n  pre_llm_call:\n    - command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'\n      timeout: 15\n",
  );
});

test("list / `pre_llm_call:` 空段：直接铺条目", () => {
  const m = mergeYamlListEntry("hooks:\n  pre_llm_call:\n  post_llm_call: []\n", "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  const lines = m.text.split("\n");
  const itemIdx = lines.findIndex((l) => l.includes("hook pre-llm-call"));
  const postIdx = lines.findIndex((l) => l.trimStart() === "post_llm_call: []");
  assert.ok(itemIdx >= 0 && itemIdx < postIdx);
});

test("list / child 是映射：conflict", () => {
  const m = mergeYamlListEntry("hooks:\n  pre_llm_call:\n    command: x\n", "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "conflict");
});

test("list / child 非空内联值：conflict", () => {
  const m = mergeYamlListEntry("hooks:\n  pre_llm_call: [x]\n", "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "conflict");
});

// ------------------------------------------------------------ 同缩进 dash（YAML 允许 key 与 `-` 同列）

test("list / dash 与 key 同缩进也认", () => {
  const before = ["hooks:", "  pre_llm_call:", "  - command: 'someone-elses'"].join("\n");
  const m = mergeYamlListEntry(before, "hooks", "pre_llm_call", HOOK_ITEM, MARKER);
  assert.equal(m.status, "changed");
  if (m.status !== "changed") return;
  const lines = m.text.split("\n");
  assert.ok(lines.some((l) => l === "  - command: 'node \"/ck/bin.js\" hook pre-llm-call --host hermes'"), m.text);
});

// ------------------------------------------------------------ yamlChildBlock

test("yamlChildBlock：取出直子块，不含下一段", () => {
  const text = "mcp_servers:\n  ck:\n    command: node\n  other: 1\ntheme: dark\n";
  const block = yamlChildBlock(text, "mcp_servers", "ck");
  assert.deepEqual(block, ["  ck:", "    command: node"]);
});

test("yamlChildBlock：找不到 / 形状不对返回 null", () => {
  assert.equal(yamlChildBlock("theme: dark\n", "mcp_servers", "ck"), null);
  assert.equal(yamlChildBlock("mcp_servers:\n", "mcp_servers", "ck"), null);
  assert.equal(yamlChildBlock("mcp_servers:\n  - a\n", "mcp_servers", "ck"), null);
});
