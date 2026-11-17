import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 宿主声明（hosts.md §6）：`agents/<host>/host.json`。
 * `ck setup` / `ck skills sync` / `ck hook` 只读这些声明，宿主差异不写进代码分支。
 * 查找顺序：CK_AGENTS_DIR → 包内 ./agents（随 ck 产物分发）→ 仓库根 agents/。
 */

export interface HostConfig {
  /** 宿主标识，与目录名一致。 */
  name: string;
  /** 显示名。 */
  title: string;
  /** MCP 条目落点。 */
  mcp: {
    /** 配置文件路径，`~` 开头表示用户目录；dsh 走 profiles。 */
    file: string;
    /** 文件格式；决定合并策略。 */
    format: "json" | "yaml" | "toml";
    /** 宿主内该条目的键路径，如 `mcpServers.ck`。 */
    key: string;
    /** 是否是顶层 `insert:` 列表（dsh 的 cordis.patch）。 */
    insert: boolean;
    /** `insert` 列表需要的插件包名（dsh 系调用 `- name: <plugin>`）。 */
    plugin?: string;
    /** MCP 条目的 `trust: true`（gemini-cli：可信文件夹里免逐次调用确认）。 */
    trust?: boolean;
    /**
     * stdio 条目把整条命令写成一个 argv 数组（opencode `type: "local"` 的 `command: [...]`），
     * 而不是 `command` + `args` 分写。
     */
    argv?: boolean;
    /** http 条目的 `type` 值（opencode 是 `"remote"`）；缺省 `"http"`。 */
    remote_type?: string;
  };
  /** 会话开始 hook；null 表示不启用。 */
  hook: {
    file: string;
    format: "json" | "yaml";
    /** `hooks.SessionStart` / `hooks.pre_llm_call` 一类的键路径。 */
    key: string;
    /** 触发时机 matcher（hermes `pre_llm_call` 无 matcher，首轮门控在 ck 侧）。 */
    matcher?: string;
    /**
     * 输出形状。`claude-code`：`hookSpecificOutput.additionalContext`；
     * `hermes-context`：`{"context": ...}`（pre_llm_call 的注入契约，拼进 user 消息）。
     */
    output: "claude-code" | "hermes-context";
    /** 命令 hook 的显式超时秒数（写进条目；codex 的信任哈希与 hermes 的 timeout 都是秒）。 */
    timeout_sec?: number;
    /** 命令 hook 的显式超时毫秒数（gemini-cli 的 hook timeout 是毫秒，DEFAULT_HOOK_TIMEOUT=60000）。 */
    timeout_ms?: number;
    /** hook 显示名/禁用键（gemini-cli 的 disabledHooks 按 config.name || config.command 匹配）。 */
    name?: string;
    /**
     * hook 信任状态落点（codex：config.toml 的 `[hooks.state.*]` 表）。
     * 声明后 `ck setup` 会预写 `enabled` + `trusted_hash`，免掉 TUI `/hooks` 审查一步。
     */
    trust?: { file: string };
    /**
     * shell hook 批准表（hermes：`shell-hooks-allowlist.json`，按 (event, command) 精确匹配）。
     * 声明后 `ck setup` 代写一条 approval，免掉交互确认 / hooks_auto_accept。
     */
    consent?: { file: string };
    /** hook 引擎还需宿主侧开关注入时，给用户的开启提示（如 codex 的 `codex features enable hooks`）。 */
    enable_hint?: string;
  } | null;
  /** `instructions` 送法。 */
  instructions: "brief" | "full";
  /** 各送法的预算；key 是投递方式。 */
  budgets: {
    instructions?: { budget_chars: number; max_bytes: number };
    hook?: { budget_chars: number };
    tool?: { budget_chars: number };
  };
  /** skill 目录（`~` 开头）。 */
  skill_dir: string;
  /** 规则文件（`~` 开头）；`ck setup --rules` 往这里写带标记的块。不声明则 `--rules` 报错。 */
  rules_file?: string;
  /** 本机可导入资产的扫描位置（P2），现在只做声明。 */
  import_scan?: string[];
  /**
   * 平台覆盖：`platforms.win32` 一类的字段级覆盖，在 `hostConfig()` 里按 `process.platform` 深合并
   * （mcp/hook 按字段合、其他整体换）。给 home 不在 `~` 下的宿主用——hermes Windows 是 `%LOCALAPPDATA%/hermes`。
   */
  platforms?: Partial<Record<"win32" | "darwin" | "linux", HostPlatformOverride>>;
}

export interface HostPlatformOverride {
  mcp?: Partial<HostConfig["mcp"]>;
  hook?: Partial<NonNullable<HostConfig["hook"]>>;
  skill_dir?: string;
  rules_file?: string;
  import_scan?: string[];
}

const BUILTIN: Record<string, HostConfig> = {
  "claude-code": {
    name: "claude-code",
    title: "Claude Code",
    mcp: { file: "~/.claude.json", format: "json", key: "mcpServers.ck", insert: false },
    hook: { file: "~/.claude/settings.json", format: "json", key: "hooks.SessionStart", matcher: "startup|clear|compact", output: "claude-code" },
    instructions: "brief",
    budgets: { hook: { budget_chars: 8000 }, tool: { budget_chars: 12000 } },
    skill_dir: "~/.claude/skills",
    rules_file: "~/.claude/CLAUDE.md",
    import_scan: ["~/.claude/skills", "<workspace>/.claude/skills"],
  },
  dsh: {
    name: "dsh",
    title: "DeepSeek Harness",
    mcp: { file: "~/.dsh/cordis.patch.yml", format: "yaml", key: "cinlan-knowledge", insert: true, plugin: "@deepseek-ai/dsh-mcp-client" },
    hook: null,
    instructions: "full",
    budgets: { instructions: { budget_chars: 12000, max_bytes: 24000 } },
    skill_dir: "~/.agents/skills",
    import_scan: ["<workspace>/.dsh/skills", "<workspace>/.agents/skills", "$DSH_HOME/skills", "~/.agents/skills"],
  },
  "cinlan-harness": {
    name: "cinlan-harness",
    title: "Cinlan Harness",
    mcp: {
      file: "~/.clh/cordis.patch.yml",
      format: "yaml",
      key: "cinlan-knowledge",
      insert: true,
      plugin: "@deepseek-ai/dsh-mcp-client",
    },
    hook: null,
    instructions: "full",
    budgets: { instructions: { budget_chars: 12000, max_bytes: 24000 } },
    skill_dir: "~/.agents/skills",
    import_scan: ["<workspace>/.clh/skills", "<workspace>/.agents/skills", "$CLH_HOME/skills", "~/.agents/skills"],
  },
  codex: {
    name: "codex",
    title: "Codex CLI",
    mcp: { file: "~/.codex/config.toml", format: "toml", key: "mcp_servers.ck", insert: false },
    hook: {
      file: "~/.codex/hooks.json",
      format: "json",
      key: "hooks.SessionStart",
      matcher: "startup|clear|compact",
      output: "claude-code",
      timeout_sec: 15,
      trust: { file: "~/.codex/config.toml" },
      enable_hint: "codex features enable hooks",
    },
    instructions: "brief",
    budgets: { hook: { budget_chars: 8000 }, tool: { budget_chars: 12000 } },
    skill_dir: "~/.agents/skills",
    rules_file: "~/.codex/AGENTS.md",
    import_scan: ["~/.agents/skills", "<workspace>/.agents/skills"],
  },
  "gemini-cli": {
    name: "gemini-cli",
    title: "Gemini CLI",
    // ~/.gemini/settings.json 单文件同时承载 mcpServers.ck 与 hooks.SessionStart；
    // trust: true → 可信文件夹里免逐次 MCP 调用确认（cliConfig.isTrustedFolder() && trust）。
    mcp: { file: "~/.gemini/settings.json", format: "json", key: "mcpServers.ck", insert: false, trust: true },
    hook: {
      file: "~/.gemini/settings.json",
      format: "json",
      key: "hooks.SessionStart",
      // gemini SessionStart 的 source 只有 startup|resume|clear；压缩走独立 PreCompress 事件。
      matcher: "startup|resume|clear",
      output: "claude-code",
      timeout_ms: 15000,
      name: "cinlan-knowledge",
      // hooks 引擎默认开（enableHooks ?? true），项目级才查 trusted_hooks.json；用户级无门槛。
    },
    instructions: "brief",
    budgets: { hook: { budget_chars: 8000 }, tool: { budget_chars: 12000 } },
    skill_dir: "~/.agents/skills",
    rules_file: "~/.gemini/GEMINI.md",
    import_scan: ["~/.gemini/skills", "~/.agents/skills", "<workspace>/.gemini/skills", "<workspace>/.agents/skills"],
  },
  generic: {
    name: "generic",
    title: "Generic MCP host",
    mcp: { file: "", format: "json", key: "mcpServers.ck", insert: false },
    hook: null,
    instructions: "brief",
    budgets: { tool: { budget_chars: 12000 } },
    skill_dir: "~/.agents/skills",
  },
  opencode: {
    name: "opencode",
    title: "OpenCode",
    // opencode.json 顶层 `mcp.<name>`（v2 归一化到 mcp.servers，v1 形状仍读，hosts.md §4.7）；
    // local 条目 command 是整条 argv 数组，remote 条目 type 是 "remote"。
    mcp: { file: "~/.config/opencode/opencode.json", format: "json", key: "mcp.ck", insert: false, argv: true, remote_type: "remote" },
    // 无配置式 shell hook（session.created 不向上下文注入）：baseline 走 MCP instructions（brief）
    // 与 --rules 的 AGENTS.md 标记块。
    hook: null,
    instructions: "brief",
    budgets: { tool: { budget_chars: 12000 } },
    skill_dir: "~/.config/opencode/skills",
    rules_file: "~/.config/opencode/AGENTS.md",
    import_scan: ["~/.config/opencode/skills", "~/.agents/skills", "<workspace>/.opencode/skills", "<workspace>/.agents/skills"],
  },
  hermes: {
    name: "hermes",
    title: "Hermes (Nous Research)",
    // config.yaml 单文件承载 mcp_servers.ck 与 hooks.pre_llm_call；结构化合并，非 dsh 式 insert。
    mcp: { file: "~/.hermes/config.yaml", format: "yaml", key: "mcp_servers.ck", insert: false },
    hook: {
      file: "~/.hermes/config.yaml",
      format: "yaml",
      key: "hooks.pre_llm_call",
      output: "hermes-context",
      timeout_sec: 15,
      // shell hook 要 (event, command) 进 allowlist 才跑；ck setup 代写，免 TTY 确认。
      consent: { file: "~/.hermes/shell-hooks-allowlist.json" },
    },
    instructions: "brief",
    budgets: { hook: { budget_chars: 8000 }, tool: { budget_chars: 12000 } },
    skill_dir: "~/.hermes/skills",
    // 无 rules_file：SOUL.md 是用户自撰上下文文件，不是托管点（hosts.md §4.6）。
    import_scan: ["~/.hermes/skills", "~/.agents/skills", "<workspace>/.hermes/skills", "<workspace>/.agents/skills"],
    platforms: {
      win32: {
        mcp: { file: "%LOCALAPPDATA%/hermes/config.yaml" },
        hook: {
          file: "%LOCALAPPDATA%/hermes/config.yaml",
          consent: { file: "%LOCALAPPDATA%/hermes/shell-hooks-allowlist.json" },
        },
        skill_dir: "%LOCALAPPDATA%/hermes/skills",
        import_scan: [
          "%LOCALAPPDATA%/hermes/skills",
          "~/.agents/skills",
          "<workspace>/.hermes/skills",
          "<workspace>/.agents/skills",
        ],
      },
    },
  },
};

function agentsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.CK_AGENTS_DIR;
  if (fromEnv && fromEnv !== "") return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  // lib/hosts.js → ../agents（构建产物内含 agents/）
  const bundled = resolve(here, "..", "agents");
  if (existsSync(bundled)) return bundled;
  // 仓库布局：packages/cli/lib → 仓库根/agents
  const repo = resolve(here, "..", "..", "..", "agents");
  if (existsSync(repo)) return repo;
  return null;
}

/** 应用 `platforms[process.platform]` 覆盖：mcp/hook 按字段合、其他整体换。 */
function applyPlatforms(cfg: HostConfig): HostConfig {
  const ov = cfg.platforms?.[process.platform as "win32" | "darwin" | "linux"];
  if (!ov) return cfg;
  const out = { ...cfg };
  if (ov.mcp !== undefined) out.mcp = { ...cfg.mcp, ...ov.mcp };
  if (ov.hook !== undefined && cfg.hook !== null) out.hook = { ...cfg.hook, ...ov.hook };
  if (ov.skill_dir !== undefined) out.skill_dir = ov.skill_dir;
  if (ov.rules_file !== undefined) out.rules_file = ov.rules_file;
  if (ov.import_scan !== undefined) out.import_scan = ov.import_scan;
  return out;
}

/** 读声明；声明文件缺失或损坏时用内置表。 */
export function hostConfig(name: string, env: NodeJS.ProcessEnv = process.env): HostConfig {
  // install.md §5 写的 `generic-mcp` 是 `generic` 的别名（同一份声明，只是历史叫法不同）
  const key = name === "generic-mcp" ? "generic" : name;
  const builtin = BUILTIN[key];
  const dir = agentsDir(env);
  if (dir) {
    const file = join(dir, key, "host.json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HostConfig>;
        if (typeof parsed.name === "string" && parsed.mcp !== undefined) {
          return applyPlatforms({ ...(builtin ?? ({} as HostConfig)), ...(parsed as HostConfig) });
        }
      } catch {
        // 坏声明退回内置表，doctor 会报出来
      }
    }
  }
  if (!builtin) throw new Error(`unknown host "${name}"; known: ${Object.keys(BUILTIN).join(", ")}`);
  return applyPlatforms(builtin);
}

export function knownHosts(): string[] {
  return Object.keys(BUILTIN);
}

/** `hooks.SessionStart` → `session_start`（宿主侧事件名；codex 状态键 / hermes allowlist 的 event）。 */
export function hookEventName(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `hooks.SessionStart` → `session-start`（`ck hook <event>` 的 CLI 名）。 */
export function hookEventCli(key: string): string {
  return hookEventName(key).replace(/_/g, "-");
}
