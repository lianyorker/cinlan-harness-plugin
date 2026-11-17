import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, planSetup, type FileChange, type SetupOptions } from "../src/setup.js";
import { hostConfig } from "../src/hosts.js";
import { expandHome } from "../src/paths.js";

/**
 * T11 golden 集（docs/sop.md）：每种宿主一份。
 * 四种输入 —— 空配置 / 已有无关条目 / 同名条目内容一致（幂等）/ 同名条目内容不同。
 * 最后一种：条目名 `ck` 归 ck 所有（与 yaml / toml 标记块同口径，acceptance-report §5.9 取 A），
 * 原地更新不报冲突；冲突只剩结构性问题（文件不是合法 JSON、`hooks.<event>` 不是列表、
 * allowlist 根形状不对、yaml / toml 块外有同名 id / 表）。
 */

const CK = "C:\\ck\\lib\\bin.js";
const AGENT = { team: "core", name: "builder" };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ck-setup-"));
}

/** 不走 agents/ 声明，用内置表；CK_AGENTS_DIR 指向空目录保证没有外部声明覆盖。 */
function host(name: string, dir: string) {
  return hostConfig(name, { CK_AGENTS_DIR: join(dir, "__no_agents__") });
}

function options(hostName: string, home: string, extra: Partial<SetupOptions> = {}): SetupOptions {
  return {
    host: host(hostName, home),
    agent: AGENT,
    transport: "stdio",
    ckEntry: CK,
    rules: false,
    home,
    ...extra,
  };
}

function at(home: string, rel: string): string {
  return join(home, rel);
}

function parseJson(text: string | null): Record<string, any> {
  assert.ok(text !== null);
  return JSON.parse(text) as Record<string, any>;
}

function run(options: SetupOptions, write = false): { changes: FileChange[]; exitCode: number } {
  const plan = planSetup(options);
  if (write) applyPlan(plan);
  return plan;
}

function withHome(fn: (home: string) => void): void {
  const home = tempHome();
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- claude-code

test("claude-code / empty: creates config + hook, dry run writes nothing", () => {
  withHome((home) => {
    const plan = run(options("claude-code", home));
    assert.equal(plan.exitCode, 0);
    const [mcp, hook] = plan.changes;
    assert.equal(mcp!.status, "create");
    assert.equal(mcp!.file, at(home, ".claude.json"));
    assert.deepEqual(parseJson(mcp!.after).mcpServers.ck, {
      command: "node",
      args: [CK, "mcp", "--host", "claude-code", "--agent", "core/builder"],
    });
    assert.equal(hook!.status, "create");
    assert.equal(hook!.file, at(home, ".claude/settings.json"));
    const entry = parseJson(hook!.after).hooks.SessionStart[0];
    assert.equal(entry.matcher, "startup|clear|compact");
    assert.equal(entry.hooks[0].type, "command");
    assert.equal(entry.hooks[0].command, `node "${CK}" hook session-start --host claude-code --agent core/builder`);
    // dry run: 什么都没落盘
    assert.equal(existsSync(at(home, ".claude.json")), false);
    assert.equal(existsSync(at(home, ".claude/settings.json")), false);
  });
});

test("claude-code / unrelated entries: preserved, only ck added", () => {
  withHome((home) => {
    writeFileSync(
      at(home, ".claude.json"),
      JSON.stringify({ numStartups: 42, mcpServers: { other: { command: "other-srv" } } }, null, 2),
    );
    const [mcp] = run(options("claude-code", home), true).changes;
    assert.equal(mcp!.status, "update");
    const doc = parseJson(readFileSync(at(home, ".claude.json"), "utf8"));
    assert.equal(doc.numStartups, 42);
    assert.deepEqual(doc.mcpServers.other, { command: "other-srv" });
    assert.equal(doc.mcpServers.ck.command, "node");
    assert.ok(existsSync(at(home, ".claude.json.bak")), "backup written before overwrite");
    assert.deepEqual(JSON.parse(readFileSync(at(home, ".claude.json.bak"), "utf8")).numStartups, 42);
  });
});

test("claude-code / same entry twice: second run is unchanged and does not rewrite", () => {
  withHome((home) => {
    run(options("claude-code", home), true);
    const before = readFileSync(at(home, ".claude.json"), "utf8");
    const plan = run(options("claude-code", home), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged", "unchanged"]);
    assert.equal(readFileSync(at(home, ".claude.json"), "utf8"), before);
  });
});

test("claude-code / same key different content: entry owned by ck → updated in place (§5.9)", () => {
  withHome((home) => {
    const original = JSON.stringify({ mcpServers: { ck: { command: "node", args: ["/old/bin.js", "mcp"] } } }, null, 2);
    writeFileSync(at(home, ".claude.json"), original);
    const plan = run(options("claude-code", home), true);
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.changes[0]!.status, "update");
    const doc = parseJson(readFileSync(at(home, ".claude.json"), "utf8"));
    assert.deepEqual(doc.mcpServers.ck, {
      command: "node",
      args: [CK, "mcp", "--host", "claude-code", "--agent", "core/builder"],
    });
    // 接管前的条目进 .bak，可整份还原
    assert.deepEqual(JSON.parse(readFileSync(at(home, ".claude.json.bak"), "utf8")).mcpServers.ck.args, ["/old/bin.js", "mcp"]);
  });
});

test("claude-code / mcp 文件不是合法 JSON：整次不写，hook 也不落盘（一次执行要么全写要么不写）", () =>
  withHome((home) => {
    const original = "{ not json";
    mkdirSync(at(home, ".claude"), { recursive: true });
    writeFileSync(at(home, ".claude.json"), original);
    const plan = planSetup(options("claude-code", home));
    assert.deepEqual(plan.changes.map((c) => c.status), ["conflict", "create"]);
    assert.match(plan.changes[0]!.detail ?? "", /not valid JSON/);
    assert.deepEqual(applyPlan(plan), []);
    assert.equal(existsSync(at(home, ".claude/settings.json")), false);
    assert.equal(readFileSync(at(home, ".claude.json"), "utf8"), original);
  }));

test("claude-code / hook: existing same-matcher group gains our entry, foreign hook kept", () => {
  withHome((home) => {
    mkdirSync(at(home, ".claude"), { recursive: true });
    writeFileSync(
      at(home, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup|clear|compact", hooks: [{ type: "command", command: "node other.js" }] },
          ],
        },
      }),
    );
    const plan = run(options("claude-code", home), true);
    const hook = plan.changes[1]!;
    assert.equal(hook.status, "update");
    const groups = parseJson(hook.after).hooks.SessionStart;
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].hooks.map((h: { command: string }) => h.command),
      ["node other.js", `node "${CK}" hook session-start --host claude-code --agent core/builder`],
    );
  });
});

test("claude-code / --rules: marker block appended once and replaced in place", () => {
  withHome((home) => {
    mkdirSync(at(home, ".claude"), { recursive: true });
    writeFileSync(at(home, ".claude/CLAUDE.md"), "# 自有规则\n\n不要动我。\n");
    run(options("claude-code", home, { rules: true }), true);
    const first = readFileSync(at(home, ".claude/CLAUDE.md"), "utf8");
    assert.match(first, /^# 自有规则/);
    assert.equal(first.match(/>>> cinlan-knowledge/g)?.length, 1);
    assert.match(first, /knowledge_status/);

    const plan = run(options("claude-code", home, { rules: true }), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged", "unchanged", "unchanged"]);
    assert.equal(readFileSync(at(home, ".claude/CLAUDE.md"), "utf8"), first);
  });
});

test("claude-code / --transport http: url + headers, no key in host config", () => {
  withHome((home) => {
    const [mcp] = run(options("claude-code", home, { transport: "http", hubUrl: "http://hub:8424/" })).changes;
    assert.deepEqual(parseJson(mcp!.after).mcpServers.ck, {
      type: "http",
      url: "http://hub:8424/mcp",
      headers: { "x-ck-agent": "core/builder", "x-ck-host": "claude-code", "x-ck-baseline": "brief" },
    });
    assert.doesNotMatch(mcp!.after ?? "", /authorization/i);
  });
});

// ------------------------------------------------------------------- dsh / yaml

test("dsh / empty: creates marked yaml block with full baseline", () => {
  withHome((home) => {
    const plan = run(options("dsh", home));
    assert.equal(plan.exitCode, 0);
    const [mcp] = plan.changes;
    assert.equal(mcp!.status, "create");
    assert.equal(mcp!.file, at(home, ".dsh/cordis.patch.yml"));
    assert.equal(mcp!.after, [
      "# >>> cinlan-knowledge (managed by ck setup; delete this block to detach)",
      "- insert:",
      "    - id: cinlan-knowledge",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: ck",
      "        transport: stdio",
      "        command: node",
      `        args: ['${CK}', 'mcp', '--host', 'dsh', '--agent', 'core/builder', '--baseline', 'full']`,
      "# <<< cinlan-knowledge",
      "",
    ].join("\n"));
  });
});

test("dsh / unrelated content: preserved above the block", () => {
  withHome((home) => {
    mkdirSync(at(home, ".dsh"), { recursive: true });
    const original = "- insert:\n    - id: telemetry\n      name: '@dsh/otel'\n";
    writeFileSync(at(home, ".dsh/cordis.patch.yml"), original);
    run(options("dsh", home), true);
    const text = readFileSync(at(home, ".dsh/cordis.patch.yml"), "utf8");
    assert.ok(text.startsWith(original), "existing rows untouched");
    assert.equal(text.match(/- insert:/g)?.length, 2);
    assert.match(text, /id: cinlan-knowledge/);
  });
});

test("dsh / same entry twice: no duplicate block", () => {
  withHome((home) => {
    run(options("dsh", home), true);
    const before = readFileSync(at(home, ".dsh/cordis.patch.yml"), "utf8");
    const plan = run(options("dsh", home), true);
    assert.equal(plan.changes[0]!.status, "unchanged");
    assert.equal(readFileSync(at(home, ".dsh/cordis.patch.yml"), "utf8"), before);
    assert.equal(before.match(/>>> cinlan-knowledge/g)?.length, 1);
  });
});

test("dsh / id exists outside the block: refused", () => {
  withHome((home) => {
    mkdirSync(at(home, ".dsh"), { recursive: true });
    const original = "- insert:\n    - id: 'cinlan-knowledge'\n      name: 'hand-written'\n";
    writeFileSync(at(home, ".dsh/cordis.patch.yml"), original);
    const plan = run(options("dsh", home), true);
    assert.equal(plan.exitCode, 1);
    assert.equal(plan.changes[0]!.status, "conflict");
    assert.match(plan.changes[0]!.detail ?? "", /already exists outside/);
    assert.equal(readFileSync(at(home, ".dsh/cordis.patch.yml"), "utf8"), original);
  });
});

test("dsh / block content changed: replaced in place, not duplicated", () => {
  withHome((home) => {
    run(options("dsh", home, { transport: "stdio" }), true);
    // 改成 http 再跑：块归 ck 所有，原地替换
    const plan = run(options("dsh", home, { transport: "http", hubUrl: "http://hub:8424" }), true);
    assert.equal(plan.changes[0]!.status, "update");
    const text = readFileSync(at(home, ".dsh/cordis.patch.yml"), "utf8");
    assert.equal(text.match(/- insert:/g)?.length, 1);
    assert.match(text, /transport: streamable-http/);
    assert.match(text, /url: 'http:\/\/hub:8424\/mcp'/);
    assert.doesNotMatch(text, /command: node/);
  });
});

// ------------------------------------------------------------ cinlan-harness

test("cinlan-harness / empty: writes its own cordis.patch.yml", () => {
  withHome((home) => {
    const [mcp] = run(options("cinlan-harness", home)).changes;
    assert.equal(mcp!.file, at(home, ".clh/cordis.patch.yml"));
    assert.equal(mcp!.status, "create");
    assert.match(mcp!.after ?? "", /id: cinlan-knowledge/);
    assert.match(mcp!.after ?? "", /'--host', 'cinlan-harness', '--agent', 'core\/builder', '--baseline', 'full'/);
  });
});

test("cinlan-harness / unrelated content: preserved above the block", () => {
  withHome((home) => {
    mkdirSync(at(home, ".clh"), { recursive: true });
    const original = "- insert:\n    - id: telemetry\n      name: '@dsh/otel'\n";
    writeFileSync(at(home, ".clh/cordis.patch.yml"), original);
    run(options("cinlan-harness", home), true);
    const text = readFileSync(at(home, ".clh/cordis.patch.yml"), "utf8");
    assert.ok(text.startsWith(original), "existing rows untouched");
    assert.equal(text.match(/- insert:/g)?.length, 2);
    assert.match(text, /id: cinlan-knowledge/);
  });
});

test("cinlan-harness / same entry twice: no duplicate block", () => {
  withHome((home) => {
    run(options("cinlan-harness", home), true);
    const before = readFileSync(at(home, ".clh/cordis.patch.yml"), "utf8");
    const plan = run(options("cinlan-harness", home), true);
    assert.equal(plan.changes[0]!.status, "unchanged");
    assert.equal(readFileSync(at(home, ".clh/cordis.patch.yml"), "utf8"), before);
    assert.equal(before.match(/>>> cinlan-knowledge/g)?.length, 1);
  });
});

test("cinlan-harness / id exists outside the block: refused", () => {
  withHome((home) => {
    mkdirSync(at(home, ".clh"), { recursive: true });
    const original = "- insert:\n    - id: 'cinlan-knowledge'\n      name: 'hand-written'\n";
    writeFileSync(at(home, ".clh/cordis.patch.yml"), original);
    const plan = run(options("cinlan-harness", home), true);
    assert.equal(plan.exitCode, 1);
    assert.equal(plan.changes[0]!.status, "conflict");
    assert.match(plan.changes[0]!.detail ?? "", /already exists outside/);
    assert.equal(readFileSync(at(home, ".clh/cordis.patch.yml"), "utf8"), original);
  });
});

// ------------------------------------------------------------------- codex

test("codex / empty: config.toml block (mcp + trust) and hooks.json", () => {
  withHome((home) => {
    const plan = run(options("codex", home));
    assert.equal(plan.exitCode, 0);
    const [toml, hook] = plan.changes;
    assert.equal(toml!.status, "create");
    assert.equal(toml!.file, at(home, ".codex/config.toml"));
    assert.match(toml!.after ?? "", /# >>> cinlan-knowledge/);
    assert.match(toml!.after ?? "", /\[mcp_servers\.ck\]/);
    assert.match(toml!.after ?? "", /command = "node"/);
    assert.match(toml!.after ?? "", new RegExp(`args = \\['${CK.replace(/\\/g, "\\\\")}', 'mcp', '--host', 'codex', '--agent', 'core\\/builder'\\]`));
    // 信任表：hooks.json 路径 + session_start:0:0 + sha256 哈希
    const keyPath = `${at(home, ".codex/hooks.json")}:session_start:0:0`;
    assert.match(toml!.after ?? "", new RegExp(`\\[hooks\\.state\\.'${keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\]`));
    assert.match(toml!.after ?? "", /enabled = true/);
    assert.match(toml!.after ?? "", /trusted_hash = 'sha256:[0-9a-f]{64}'/);
    assert.match(toml!.detail ?? "", /features enable hooks/);
    // hooks.json
    assert.equal(hook!.status, "create");
    assert.equal(hook!.file, at(home, ".codex/hooks.json"));
    const entry = parseJson(hook!.after).hooks.SessionStart[0];
    assert.equal(entry.matcher, "startup|clear|compact");
    assert.equal(entry.hooks[0].type, "command");
    assert.equal(entry.hooks[0].timeout, 15);
    assert.equal(entry.hooks[0].command, `node "${CK}" hook session-start --host codex --agent core/builder`);
    assert.equal(existsSync(at(home, ".codex/config.toml")), false);
    assert.equal(existsSync(at(home, ".codex/hooks.json")), false);
  });
});

test("codex / unrelated content: preserved, block appended at end", () => {
  withHome((home) => {
    mkdirSync(at(home, ".codex"), { recursive: true });
    const original = 'model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "other-srv"\n';
    writeFileSync(at(home, ".codex/config.toml"), original);
    run(options("codex", home), true);
    const text = readFileSync(at(home, ".codex/config.toml"), "utf8");
    assert.ok(text.startsWith(original), "existing content untouched");
    assert.match(text, /\[mcp_servers\.ck\]/);
    assert.match(text, /\[hooks\.state\./);
    assert.ok(existsSync(at(home, ".codex/config.toml.bak")), "backup written");
  });
});

test("codex / same entry twice: unchanged, no duplicate block or trust table", () => {
  withHome((home) => {
    run(options("codex", home), true);
    const before = readFileSync(at(home, ".codex/config.toml"), "utf8");
    const plan = run(options("codex", home), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged", "unchanged"]);
    assert.equal(readFileSync(at(home, ".codex/config.toml"), "utf8"), before);
    assert.equal(before.match(/# >>> cinlan-knowledge/g)?.length, 1);
    assert.equal(before.match(/\[mcp_servers\.ck\]/g)?.length, 1);
  });
});

test("codex / [mcp_servers.ck] outside block: conflict, file untouched", () => {
  withHome((home) => {
    mkdirSync(at(home, ".codex"), { recursive: true });
    const original = '[mcp_servers.ck]\ncommand = "hand-written"\n';
    writeFileSync(at(home, ".codex/config.toml"), original);
    const plan = run(options("codex", home), true);
    assert.equal(plan.exitCode, 1);
    assert.equal(plan.changes[0]!.status, "conflict");
    assert.match(plan.changes[0]!.detail ?? "", /already exists outside/);
    assert.equal(readFileSync(at(home, ".codex/config.toml"), "utf8"), original);
  });
});

test("codex / existing hooks.json same-matcher group: merged, trust indices follow", () => {
  withHome((home) => {
    mkdirSync(at(home, ".codex"), { recursive: true });
    writeFileSync(
      at(home, ".codex/hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup|clear|compact", hooks: [{ type: "command", command: "node other.js" }] },
          ],
        },
      }),
    );
    const plan = run(options("codex", home), true);
    const [toml, hook] = plan.changes;
    assert.equal(hook!.status, "update");
    const groups = parseJson(hook!.after).hooks.SessionStart;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks.length, 2);
    // 我们的条目落在 group 0 handler 1 → 信任键下标跟到 0:1
    const keyPath = `${at(home, ".codex/hooks.json")}:session_start:0:1`;
    assert.match(toml!.after ?? "", new RegExp(keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("codex / 换 --agent 重跑：两个文件都原地更新，信任表跟着换（§5.9：条目归 ck 所有）", () => {
  withHome((home) => {
    run(options("codex", home), true);
    const plan = run(options("codex", home, { agent: { team: "core", name: "other" } }), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["update", "update"]);
    const toml = readFileSync(at(home, ".codex/config.toml"), "utf8");
    // MCP 条目指向新 Agent；信任表也按新命令重算（hash 对得上 doctor 才全绿）
    assert.match(toml, /--agent', 'core\/other'/);
    const hooks = parseJson(readFileSync(at(home, ".codex/hooks.json"), "utf8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command as string;
    assert.match(command, /--agent core\/other$/);
  });
});

test("codex / hooks.json 不是合法 JSON：整次不写（config.toml 也不动）", () => {
  withHome((home) => {
    mkdirSync(at(home, ".codex"), { recursive: true });
    writeFileSync(at(home, ".codex/hooks.json"), "{ not json");
    const plan = planSetup(options("codex", home));
    assert.equal(plan.exitCode, 1);
    assert.ok(plan.changes.some((c) => c.status === "conflict"));
    assert.deepEqual(applyPlan(plan), []);
    assert.equal(existsSync(at(home, ".codex/config.toml")), false);
  });
});

test("codex / http transport: url + bearer_token_env_var + headers, no key in file", () => {
  withHome((home) => {
    const [toml] = run(options("codex", home, { transport: "http", hubUrl: "http://hub:8424/" })).changes;
    assert.match(toml!.after ?? "", /url = 'http:\/\/hub:8424\/mcp'/);
    // 与 ck 自己读的变量同名（config.ts 的 CK_USER_KEY），一个 export 两边都用
    assert.match(toml!.after ?? "", /bearer_token_env_var = "CK_USER_KEY"/);
    assert.match(toml!.after ?? "", /"x-ck-agent" = 'core\/builder'/);
    assert.match(toml!.after ?? "", /"x-ck-baseline" = 'brief'/);
    assert.doesNotMatch(toml!.after ?? "", /command = "node"/);
  });
});

// ---------------------------------------------------------------- gemini-cli

test("gemini-cli / empty: one change merges mcp + SessionStart into settings.json", () => {
  withHome((home) => {
    const plan = run(options("gemini-cli", home));
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.changes.length, 1);
    const [change] = plan.changes;
    assert.equal(change!.status, "create");
    assert.equal(change!.file, at(home, ".gemini/settings.json"));
    const doc = parseJson(change!.after);
    assert.equal(doc.mcpServers.ck.command, "node");
    assert.deepEqual(doc.mcpServers.ck.args.slice(1), ["mcp", "--host", "gemini-cli", "--agent", "core/builder"]);
    assert.equal(doc.mcpServers.ck.trust, true);
    const groups = doc.hooks.SessionStart;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, "startup|resume|clear");
    assert.equal(groups[0].hooks[0].type, "command");
    assert.equal(groups[0].hooks[0].name, "cinlan-knowledge");
    assert.equal(groups[0].hooks[0].timeout, 15000);
    assert.equal(groups[0].hooks[0].command, `node "${CK}" hook session-start --host gemini-cli --agent core/builder`);
    // dry run 不落盘
    assert.equal(existsSync(at(home, ".gemini/settings.json")), false);
  });
});

test("gemini-cli / unrelated content: preserved, both keys merged in one write", () => {
  withHome((home) => {
    mkdirSync(at(home, ".gemini"), { recursive: true });
    writeFileSync(
      at(home, ".gemini/settings.json"),
      JSON.stringify({ mcpServers: { rea: { command: "x", args: ["y"] } }, theme: "dark" }, null, 2),
    );
    run(options("gemini-cli", home), true);
    const doc = parseJson(readFileSync(at(home, ".gemini/settings.json"), "utf8"));
    assert.deepEqual(doc.mcpServers.rea, { command: "x", args: ["y"] });
    assert.equal(doc.theme, "dark");
    assert.equal(doc.mcpServers.ck.command, "node");
    assert.equal(doc.hooks.SessionStart.length, 1);
    assert.ok(existsSync(at(home, ".gemini/settings.json.bak")), "backup written");
  });
});

test("gemini-cli / same entries twice: unchanged, single change", () => {
  withHome((home) => {
    run(options("gemini-cli", home), true);
    const before = readFileSync(at(home, ".gemini/settings.json"), "utf8");
    const plan = run(options("gemini-cli", home), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged"]);
    assert.equal(readFileSync(at(home, ".gemini/settings.json"), "utf8"), before);
  });
});

test("gemini-cli / mcpServers.ck with different content: owned by ck → updated in place", () => {
  withHome((home) => {
    mkdirSync(at(home, ".gemini"), { recursive: true });
    const original = JSON.stringify({ mcpServers: { ck: { command: "hand-written" } } });
    writeFileSync(at(home, ".gemini/settings.json"), original);
    const plan = run(options("gemini-cli", home), true);
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.changes[0]!.status, "update");
    const doc = parseJson(readFileSync(at(home, ".gemini/settings.json"), "utf8"));
    assert.equal(doc.mcpServers.ck.command, "node");
    assert.deepEqual(JSON.parse(readFileSync(at(home, ".gemini/settings.json.bak"), "utf8")).mcpServers.ck, {
      command: "hand-written",
    });
  });
});

test("gemini-cli / existing SessionStart same-matcher group: merged, no duplicate group", () => {
  withHome((home) => {
    mkdirSync(at(home, ".gemini"), { recursive: true });
    writeFileSync(
      at(home, ".gemini/settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup|resume|clear", hooks: [{ type: "command", command: "node other.js" }] },
          ],
        },
      }),
    );
    const plan = run(options("gemini-cli", home), true);
    assert.equal(plan.changes.length, 1);
    const groups = parseJson(plan.changes[0]!.after).hooks.SessionStart;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks.length, 2);
  });
});

test("gemini-cli / http transport: type http + url + headers + trust, no key in file", () => {
  withHome((home) => {
    const [change] = run(options("gemini-cli", home, { transport: "http", hubUrl: "http://hub:8424/" })).changes;
    const doc = parseJson(change!.after);
    assert.equal(doc.mcpServers.ck.type, "http");
    assert.equal(doc.mcpServers.ck.url, "http://hub:8424/mcp");
    assert.equal(doc.mcpServers.ck.headers["x-ck-agent"], "core/builder");
    assert.equal(doc.mcpServers.ck.headers["x-ck-host"], "gemini-cli");
    assert.equal(doc.mcpServers.ck.trust, true);
    assert.doesNotMatch(change!.after ?? "", /ck_[A-Za-z0-9]{8,}/);
  });
});

// ------------------------------------------------------------------- 边界

test("generic host with no config file declared → explicit error", () => {
  withHome((home) => {
    assert.throws(() => planSetup(options("generic", home)), /no MCP config file/);
  });
});

test("unknown host with no declaration → explicit error", () => {
  withHome((home) => {
    assert.throws(() => host("nope", home), /unknown host/);
  });
});

test("http transport without hub url → explicit error", () => {
  withHome((home) => {
    assert.throws(() => planSetup(options("claude-code", home, { transport: "http" })), /requires a hub url/);
  });
});

test("corrupt json config → conflict, not a crash", () => {
  withHome((home) => {
    writeFileSync(at(home, ".claude.json"), "{not json");
    const [mcp] = run(options("claude-code", home), true).changes;
    assert.equal(mcp!.status, "conflict");
    assert.match(mcp!.detail ?? "", /not valid JSON/);
    assert.equal(readFileSync(at(home, ".claude.json"), "utf8"), "{not json");
  });
});

// ------------------------------------------------------------------- hermes

/** hermes 的 home：POSIX `~/.hermes`，win32 `%LOCALAPPDATA%/hermes`——env 注入让两种都落进临时目录。 */
function hermesEnv(home: string): NodeJS.ProcessEnv {
  return { LOCALAPPDATA: join(home, "localappdata") };
}

function hermesFile(home: string, env: NodeJS.ProcessEnv, rel: string): string {
  const declared = process.platform === "win32" ? `%LOCALAPPDATA%/hermes/${rel}` : `~/.hermes/${rel}`;
  return expandHome(declared, home, env);
}

function hermesOptions(home: string, extra: Partial<SetupOptions> = {}): SetupOptions {
  return options("hermes", home, { env: hermesEnv(home), ...extra });
}

test("hermes / empty: one shared config.yaml change + allowlist, command 逐字符一致", () => {
  withHome((home) => {
    const env = hermesEnv(home);
    const plan = run(hermesOptions(home));
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.changes.length, 2);

    const [config, allowlist] = plan.changes;
    assert.equal(config!.status, "create");
    assert.equal(config!.file, hermesFile(home, env, "config.yaml"));
    const text = config!.after!;
    assert.match(text, /^mcp_servers:\n  ck:\n    command: node\n    args: \[/m);
    assert.match(text, /'mcp', '--host', 'hermes', '--agent', 'core\/builder'/);
    const wantCommand = `node "${CK}" hook pre-llm-call --host hermes --agent core/builder`;
    assert.ok(text.includes(`hooks:\n  pre_llm_call:\n    - command: '${wantCommand}'\n      timeout: 15`), text);

    assert.equal(allowlist!.status, "create");
    assert.equal(allowlist!.file, hermesFile(home, env, "shell-hooks-allowlist.json"));
    // hermes `_read_allowlist`：根必须是 {"approvals": [...]}；顶层列表按不可读处理，hook 不注册
    const doc = parseJson(allowlist!.after);
    assert.deepEqual(Object.keys(doc), ["approvals"]);
    const entry = doc["approvals"] as Record<string, unknown>[];
    assert.equal(entry.length, 1);
    assert.equal(entry[0]!["event"], "pre_llm_call");
    // (event, command) 精确匹配：allowlist 的 command 必须与 YAML 里那行逐字符一致
    assert.equal(entry[0]!["command"], `node "${CK}" hook pre-llm-call --host hermes --agent core/builder`);
    assert.ok(text.includes(entry[0]!["command"] as string));
    assert.equal(typeof entry[0]!["approved_at"], "string");
  });
});

test("hermes / existing config: 其他键原样保留，两条顶层段各并一条", () => {
  withHome((home) => {
    const env = hermesEnv(home);
    const file = hermesFile(home, env, "config.yaml");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      [
        "model: kimi-k2",
        "mcp_servers:",
        "  other:",
        "    command: x",
        "hooks:",
        "  on_session_start:",
        "    - command: 'welcome.sh'",
        "theme: dark",
        "",
      ].join("\n"),
    );
    const [config] = run(hermesOptions(home), true).changes;
    assert.equal(config!.status, "update");
    const out = readFileSync(file, "utf8");
    assert.match(out, /^model: kimi-k2$/m);
    assert.match(out, /^  other:\n    command: x$/m);
    assert.match(out, /on_session_start:\n    - command: 'welcome\.sh'/);
    assert.match(out, /^theme: dark$/m);
    assert.match(out, /^  ck:\n    command: node$/m);
    assert.match(out, /^  pre_llm_call:\n    - command: /m);
    assert.ok(existsSync(`${file}.bak`), "backup written");
  });
});

test("hermes / same entries twice: config + allowlist both unchanged", () => {
  withHome((home) => {
    run(hermesOptions(home), true);
    const env = hermesEnv(home);
    const before = readFileSync(hermesFile(home, env, "config.yaml"), "utf8");
    const plan = run(hermesOptions(home), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged", "unchanged"]);
    assert.equal(readFileSync(hermesFile(home, env, "config.yaml"), "utf8"), before);
  });
});

test("hermes / mcp_servers.ck 内容不同：conflict，且不写 allowlist", () => {
  withHome((home) => {
    const env = hermesEnv(home);
    const file = hermesFile(home, env, "config.yaml");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "mcp_servers:\n  ck:\n    command: python\n    args: ['-m', 'other']\n");
    const plan = run(hermesOptions(home), true);
    assert.equal(plan.exitCode, 1);
    assert.equal(plan.changes.length, 1, "conflict 时 allowlist 不生成");
    assert.equal(plan.changes[0]!.status, "conflict");
    assert.match(plan.changes[0]!.detail ?? "", /mcp_servers\.ck exists with different content/);
    assert.equal(existsSync(hermesFile(home, env, "shell-hooks-allowlist.json")), false);
  });
});

test("hermes / allowlist 已有他条：并入不覆盖；重跑不重复", () => {
  withHome((home) => {
    const env = hermesEnv(home);
    const consent = hermesFile(home, env, "shell-hooks-allowlist.json");
    mkdirSync(join(consent, ".."), { recursive: true });
    // hermes 自己落盘的形状（`_record_approval` + sort_keys）
    writeFileSync(
      consent,
      JSON.stringify(
        {
          approvals: [
            { approved_at: "2026-01-01T00:00:00Z", command: "other-tool", event: "pre_llm_call", script_mtime_at_approval: null },
          ],
          note: "keep",
        },
        null,
        2,
      ),
    );
    run(hermesOptions(home), true);
    const doc = parseJson(readFileSync(consent, "utf8"));
    assert.equal(doc["note"], "keep", "根上的其他键原样保留");
    const list = doc["approvals"] as Record<string, unknown>[];
    assert.equal(list.length, 2);
    assert.equal(list[0]!["command"], "other-tool");
    assert.equal(list[1]!["event"], "pre_llm_call");
    assert.equal(list[1]!["command"], `node "${CK}" hook pre-llm-call --host hermes --agent core/builder`);
    const plan = run(hermesOptions(home), true);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged", "unchanged"]);
  });
});

test("hermes / allowlist 不是 {approvals: [...]}：conflict，原文件不动", () => {
  for (const body of ['[{"event":"pre_llm_call","command":"other-tool"}]', '{"approvals":"nope"}', "{not json"]) {
    withHome((home) => {
      const env = hermesEnv(home);
      const consent = hermesFile(home, env, "shell-hooks-allowlist.json");
      mkdirSync(join(consent, ".."), { recursive: true });
      writeFileSync(consent, body);
      const plan = run(hermesOptions(home), true);
      assert.equal(plan.exitCode, 1);
      const change = plan.changes.find((c) => c.file === consent);
      assert.equal(change!.status, "conflict", body);
      assert.match(change!.detail ?? "", /approvals/);
      assert.equal(readFileSync(consent, "utf8"), body);
      // 批准表写不了，config.yaml 也不写：接了线却没批准的 hook 不会跑
      assert.equal(existsSync(hermesFile(home, env, "config.yaml")), false);
    });
  }
});

test("hermes / script_mtime_at_approval 与 hermes `script_mtime_iso` 同串：整秒不带小数，否则 6 位微秒", () => {
  withHome((home) => {
    const ckEntry = join(home, "bin.js");
    writeFileSync(ckEntry, "");
    for (const [mtime, want] of [
      [1577934245, "2020-01-02T03:04:05Z"],
      [1577934245.5, "2020-01-02T03:04:05.500000Z"],
    ] as const) {
      utimesSync(ckEntry, mtime, mtime);
      const [, allowlist] = run(hermesOptions(home, { ckEntry })).changes;
      const entry = (parseJson(allowlist!.after)["approvals"] as Record<string, unknown>[])[0]!;
      assert.equal(entry["script_mtime_at_approval"], want);
    }
  });
});

test("hermes / http transport: url + headers，不进 command", () => {
  withHome((home) => {
    const [config] = run(hermesOptions(home, { transport: "http", hubUrl: "http://hub:8424/" })).changes;
    const text = config!.after!;
    assert.match(text, /^  ck:\n    url: 'http:\/\/hub:8424\/mcp'\n    headers:\n      x-ck-agent: 'core\/builder'\n      x-ck-host: 'hermes'\n      x-ck-baseline: 'brief'$/m);
    assert.doesNotMatch(text, /ck_[A-Za-z0-9]{8,}/);
  });
});

test("hermes / --rules：无托管规则文件 → 明确报错（SOUL.md 是用户自撰文件）", () => {
  withHome((home) => {
    assert.throws(() => planSetup(hermesOptions(home, { rules: true })), /no rules file/);
  });
});

// ------------------------------------------------------------------- opencode

test("opencode / empty: creates opencode.json with argv-array mcp.ck", () => {
  withHome((home) => {
    const plan = run(options("opencode", home));
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.changes.length, 1, "无 hook/consent，只有一条变更");
    const [mcp] = plan.changes;
    assert.equal(mcp!.status, "create");
    assert.equal(mcp!.file, at(home, ".config/opencode/opencode.json"));
    assert.deepEqual(parseJson(mcp!.after).mcp.ck, {
      type: "local",
      command: ["node", CK, "mcp", "--host", "opencode", "--agent", "core/builder"],
    });
    assert.equal(existsSync(at(home, ".config/opencode/opencode.json")), false, "dry run 不落盘");
  });
});

test("opencode / unrelated entries: preserved, mcp.ck added alongside", () => {
  withHome((home) => {
    const file = at(home, ".config/opencode/opencode.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark", mcp: { other: { type: "local", command: ["other"] } } }, null, 2));
    const [mcp] = run(options("opencode", home), true).changes;
    assert.equal(mcp!.status, "update");
    const doc = parseJson(readFileSync(file, "utf8"));
    assert.equal(doc.theme, "dark");
    assert.deepEqual(doc.mcp.other, { type: "local", command: ["other"] });
    assert.equal(doc.mcp.ck.type, "local");
    assert.ok(existsSync(`${file}.bak`), "backup written");
  });
});

test("opencode / same entry twice: unchanged; different content: updated in place (§5.9)", () => {
  withHome((home) => {
    run(options("opencode", home), true);
    const file = at(home, ".config/opencode/opencode.json");
    const before = readFileSync(file, "utf8");
    const plan = run(options("opencode", home), true);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(plan.changes.map((c) => c.status), ["unchanged"]);
    assert.equal(readFileSync(file, "utf8"), before);

    // 同键不同内容 → 条目归 ck 所有，原地更新
    writeFileSync(file, JSON.stringify({ mcp: { ck: { type: "local", command: ["old"] } } }, null, 2));
    const updated = run(options("opencode", home), true);
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.changes[0]!.status, "update");
    const entry = parseJson(readFileSync(file, "utf8")).mcp.ck;
    assert.deepEqual(entry.command[0], "node");
  });
});

test("opencode / http transport: type remote + url + headers", () => {
  withHome((home) => {
    const [mcp] = run(options("opencode", home, { transport: "http", hubUrl: "http://hub:8424/" })).changes;
    const entry = parseJson(mcp!.after).mcp.ck;
    assert.equal(entry.type, "remote");
    assert.equal(entry.url, "http://hub:8424/mcp");
    assert.equal(entry.headers["x-ck-agent"], "core/builder");
    assert.equal(entry.headers["x-ck-host"], "opencode");
    assert.doesNotMatch(mcp!.after ?? "", /ck_[A-Za-z0-9]{8,}/);
  });
});

test("opencode / --rules: AGENTS.md marked block create + idempotent", () => {
  withHome((home) => {
    const plan = run(options("opencode", home, { rules: true }), true);
    assert.equal(plan.changes.length, 2);
    const rules = plan.changes[1]!;
    assert.equal(rules.file, at(home, ".config/opencode/AGENTS.md"));
    assert.equal(rules.status, "create");
    const text = readFileSync(rules.file, "utf8");
    assert.ok(text.includes(">>> cinlan-knowledge"));
    assert.ok(text.includes("knowledge_status"));
    const again = run(options("opencode", home, { rules: true }), true);
    assert.deepEqual(again.changes.map((c) => c.status), ["unchanged", "unchanged"]);
  });
});
