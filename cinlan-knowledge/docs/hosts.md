# 宿主接入（多 harness / 多 CLI）

共享记忆要被很多不同的 agent harness 与 agent CLI 消费：dsh（DeepSeek Harness）、cinlan-harness、Claude Code、Codex CLI、Gemini CLI、OpenCode、Hermes、Cursor 等。目标覆盖线（decisions O-11）：P1 = dsh + cinlan-harness + Claude Code；P2 = Codex + Gemini CLI + OpenCode + Hermes（先调研）。本文规定接入模型、每个宿主的事实与默认做法、新增一个宿主要做什么。

结论先行：**运行面主通道是 MCP**；读档靠宿主的"会话开始 hook"或 MCP `instructions`；本机能力（stdio MCP、hook、skill 物化、导入、写宿主配置）收在一个客户端 CLI `ck` 里。每个宿主的适配是 `agents/<host>/` 下的一份声明加几个配置模板，不写业务代码。

## 1. 为什么不照搬腾讯的 Proxy

腾讯靠 Memory Proxy 兼容多宿主：宿主把 LLM `baseURL` 指到代理，代理在流量里做注入与抽取。其 `agents/README.md` 写"目前适配了 7 类 AI Agent 客户端"；`agents/adapter-agent-development.md` 列出每接一个客户端要实现的 11 项能力、一份 20 步清单与"3–4 个工作日"的估时。

| 腾讯 Proxy 每个客户端要做的 | 我们的对应 |
| --- | --- |
| 路由与白名单、会话 ID 解析、请求分类（main / aux / headless）、用户文本提取、wire 字段回传 | 不需要：不在 LLM 流量路径上 |
| 会话初始化表单（选 team → agent） | 配置期定一次：`--agent <team>/<name>` |
| header 预选（`x-team-id` / `x-agent-id`） | `x-ck-agent` / `x-ck-agent-id` |
| 逐轮把资产注入 system | 会话级 baseline：hook 或 MCP `instructions`（[loadout.md](loadout.md) §4） |
| `mem:` 命令拦截 | 五个工具 |
| L0 归档与 skill 抽取 | P3：`SessionEnd` / `Stop` hook → `session/report` |
| 可观测 | hub 请求日志 + 用量 + 审计 |

Proxy 换来的是宿主零感知与全量对话采集；代价是每个宿主一个协议适配器，全部 LLM 流量与模型密钥过一个单点。我们取它的**多宿主目标、setup 工具、本机资产导入**，不取 Proxy 本体，把它留作 A3 后手。

## 2. 接入等级

等级用 A0–A3 编号（A = Adapter），与腾讯记忆分层的 L0–L3 无关。

| 等级 | 组成 | 得到什么 | 适用 |
| --- | --- | --- | --- |
| A0 纯配置 | 宿主 MCP 配置里一条远端条目：`/mcp` + 请求头 | 五个工具；`instructions` 里的 baseline（宿主是否采用、采用多少见 §3） | 装不了 Node / `ck` 的机器；云端 Agent |
| **A1 标准（默认）** | `ck`：stdio MCP + 会话开始 hook + skill 物化 | A0 的全部；确定送达的完整读档；skill 进宿主原生目录；key 不进任何宿主配置 | 本机 CLI 与桌面宿主 |
| A2 原生插件 | 宿主自己的插件机制（如 dsh 的 cordis 插件） | A1 做不到的宿主内能力 | 可选，P3；开工前先写明 A1 缺什么 |
| A3 Proxy | LLM `baseURL` 代理 | 让既无 MCP 也无 hook 的宿主也能读档 | 可选，P3 |

A0 与 A1 挂的是同一套工具与同一份文本（`packages/mcp`），区别只在传输与身份从哪来。

## 3. 宿主矩阵

| 宿主 | MCP 条目 | `instructions` | 会话开始 hook | skill 目录 | 默认接入 | 期 |
| --- | --- | --- | --- | --- | --- | --- |
| dsh（DeepSeek Harness） | `cordis.patch.yml` 里 `insert` 一行 `@deepseek-ai/dsh-mcp-client`：`stdio`（`command / args / env / cwd`）或 `streamable-http`（`url / headers`） | 原文进系统提示；上限 32,768 UTF-8 字节，超限则连接失败 | 经 `dsh-hooks-claude-code` / `dsh-hooks-codex` 桥接（experimental）；`SessionStart` 只认 JSON `additionalContext`，脱离运行，可能错过首个请求 | `~/.agents/skills`、`$DSH_HOME/skills`、`customSkillDirs`、项目 `.dsh/skills` 与 `.agents/skills`；只下探一层 | A1：stdio，baseline 走 `instructions`（`full`），不用 hook | P1 |
| cinlan-harness | `~/.clh/cordis.patch.yml` 用 dsh 同款 `insert` 写法；MCP 插件包名仍是 `@deepseek-ai/dsh-mcp-client` | 同 dsh | 同 dsh | `~/.agents/skills` 等，发现根同 dsh | A1：stdio + `instructions`（`full`）；自家源码在手，将来升 A2 原生插件成本最低 | P1 |
| Claude Code | `claude mcp add` / `add-json` 或 `.mcp.json`；远端支持 `headers` / `headersHelper` | 采用，默认截断到 4,096 字符（旧版 2,048；`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 可调） | `SessionStart`（`startup / clear / compact`），`hookSpecificOutput.additionalContext` 进上下文；输出超过 10,000 字符会被改存文件、只留 2,000 字符预览 | `~/.claude/skills`、项目 `.claude/skills`；有热加载 | A1：stdio + hook；`instructions` 用 `brief` | P1 |
| Codex CLI | `~/.codex/config.toml` 的 `[mcp_servers.<name>]`：`command / args`，或 `url` + `bearer_token_env_var` / `http_headers` / `env_http_headers` / `http_headers_helper` | **不采用**：被降级为工具命名空间元数据，模型不按指令级看到（issue #29097 源码级证实；官方明确不做注入，#6148 关闭） | `~/.codex/hooks.json` 的 `hooks.SessionStart`（`startup / resume / clear / compact / fork`），`hookSpecificOutput.additionalContext` 进上下文（0.166.0 实机验证）；引擎默认关（`features.hooks`），非托管 hook 须 `/hooks` 审查或预写 `hooks.state` 信任表 | `~/.agents/skills`（递归发现）、项目 `.agents/skills`；内置 `<CODEX_HOME>/skills/.system` | A1：stdio + hook（`ck setup` 代写 `hooks.state` 信任表；开关一次 `codex features enable hooks`） | P2 |
| Gemini CLI | `~/.gemini/settings.json`（或项目级 `.gemini/settings.json`）的 `mcpServers`：`command / args`，或 `type: "http"` + `url` + `headers`；条目 `trust: true` 时可信工作区免逐次调用确认 | 采用，上限未验证；本适配走 `brief` + hook 兜底 | `settings.json` 的 `hooks.SessionStart`（`startup / resume / clear`；压缩走独立 `PreCompress`）；`hookSpecificOutput.additionalContext` 包成 `<hook_context>` user 消息注入；引擎默认开，用户级配置无信任审查，timeout 为毫秒 | `~/.gemini/skills` 与 `~/.agents/skills` 都扫；项目 `.gemini/skills` 或 `.agents/skills` | A1：stdio + hook（`ck setup` 对 settings.json 做单文件合并） | P2 |
| OpenCode | `opencode.json(c)`（全局 `~/.config/opencode/opencode.json`、项目根或 `.opencode/`、系统 `%ProgramData%\opencode`）的 `mcp.<name>`（v1）/`mcp.servers.<name>`（v2）：`"type": "local"` + `command: [...]`（整条 argv 一数组）+ `environment` + `enabled` + `timeout`(ms)；`"type": "remote"` + `url` + `headers` + oauth；`{env:VAR}` 展开；`opencode mcp add/list/auth/debug` CLI | 采用进系统提示（拒掉全部工具时连 instructions 一起撤），上限未验证 | **无配置式 shell hook**：插件（TS/JS，`.opencode/plugins/`、`~/.config/opencode/plugins/`、npm `plugin: []`）订阅 `session.created`/`session.compacted` 等事件；`session.created` 在 init 后触发且无注入通道（SessionStart issue #5409 开放中）；v2 `ctx.session.hook("prompt")` 可在入场前改写 prompt；`instructions` 数组可挂文件/glob/URL 进启动上下文 | `~/.config/opencode/skills/`、项目 `.opencode/skills/`；插件 `ctx.skill.transform` 可程序化注册 | A1-lite：stdio `mcp` 条目 + `instructions`/AGENTS.md 投递 baseline（无 hook 可依赖；v2 prompt hook 插件是升级路径）；工具名 `<server>_<tool>`（非 `[a-zA-Z0-9_-]` 归一化为 `_`，Code Mode 下 `tools.ck.knowledge_status()`） | P2 已调研，待适配 |
| Hermes | `~/.hermes/config.yaml`（Windows: `%LOCALAPPDATA%\hermes`，无点前缀）的 `mcp_servers`：`command / args / env`，或 `url` + `headers`（`transport: "sse"` 走 SSE，`connect_timeout` 秒）；条目 `enabled: false` 可禁用；`hermes mcp add/list/test` CLI 可代写 | **不采用**（源码无 MCP instructions 消费路径）→ `brief` + hook | `config.yaml` 的 `hooks:`：事件 → `[{command, matcher?, timeout(s, 默认60), fail_closed?}]`；stdin JSON，stdout `{"context": ...}` 注进 user 消息。**`on_session_start` 输出被丢弃（纯通知）**——真注入点是 `pre_llm_call`（payload 带 `is_first_turn`）；**shell hook 需同意**：`shell-hooks-allowlist.json` 白名单或 `hooks_auto_accept` / `HERMES_ACCEPT_HOOKS=1` / `--accept-hooks` | `~/.hermes/skills`（本地可写）+ `skills.external_dirs`（示例即 `~/.agents/skills`）+ 项目 `<root>/.hermes/skills`、`<root>/.agents/skills`；tier：project > local > create_dir > external | A1：stdio + `pre_llm_call` hook（`is_first_turn` 门控）；`ck setup` 用行级 YAML 合并写 `mcp_servers`/`hooks` 嵌套键（重复顶层键会互相遮蔽），并代写 `shell-hooks-allowlist.json` 的 `(event, command)` 批准 | P2 |
| Cursor、其他 MCP 宿主 | 未验证（都支持 stdio MCP 是 MCP 宿主的定义） | 未验证 | 未验证 | 未验证 | 通用做法（§4.8） | 按需 |
| CodeBuddy、WorkBuddy、OpenClaw、Pi | 未验证 | 未验证 | 未验证 | `~/.codebuddy/skills`、`~/.agents/skills` | 支持 MCP 则走通用做法（§4.8）；不支持的才评估 A3 | 按需 |

工具名在各宿主里带不同前缀：dsh、Claude Code、Codex 与 Hermes 是 `mcp__<server>__<tool>`，Gemini CLI 是 `mcp_<server>_<tool>`，OpenCode 是 `<server>_<tool>`（默认 Code Mode 再包成 `tools.<server>.<tool>()`）。server 名统一用 `ck`，工具原名保持 `knowledge_*`，注入文本里只写原名。

证据：

- dsh：`cinlan-harness/packages/mcp/mcp-client/README.zh.md` 与 `src/connection.ts`（`DEFAULT_MAX_INSTRUCTION_BYTES = 32_768`）、`docs/user/guide/mcp-memory.zh.md`（`insert` 写法）、`packages/experimental/hooks-claude-code/README.zh.md`（`SessionStart` 的限制）、`packages/skill/skill-filesystem/src/index.ts`（发现根）。
- cinlan-harness：`apps/cinlan-harness/packages/util/home-paths/src/index.ts`——home 解析是 `CLH_HOME` → `CINLAN_HARNESS_HOME` → `~/.clh`，**不读 `$DSH_HOME`**；插件包名实测 `@deepseek-ai/dsh-mcp-client`（`packages/mcp/mcp-client/package.json`）。
- Claude Code：官方仓库 `anthropics/claude-code` 的 `CHANGELOG.md`（instructions 上限、`headersHelper`、hook 输出 10,000 字符上限、`reloadSkills`、skill 热加载）；本机 2.1.310 的 `claude mcp add --help` 与 `add-json --help`（`--scope`、`--transport`、`--header`）；本机已装插件的 `hooks/hooks.json` 与其输出格式；实际会话里 SessionStart 注入在上下文压缩后重新出现。
- Codex CLI：`openai/codex` 源码 `codex-rs/config/src/mcp_types.rs`（字段名）、`codex-rs/hooks/src/events/session_start.rs`（source 枚举）、`hooks/src/engine/discovery.rs`（hooks.json/`[hooks]` 发现、`hooks.state` 信任、`commandWindows` 覆盖）；issues #29097 / #6148（instructions 降级为命名空间元数据、官方不做注入）；`learn.chatgpt.com/docs/hooks`（配置形状、`additionalContextLimit`）。本机 codex-cli 0.166.0 实机 spike：SessionStart stdin/输出契约、`hooks.state` 预写可免审查、skill 根 `~/.agents/skills` + `<CODEX_HOME>/skills/.system`、工具前缀 `mcp__<server>__<tool>`。
- Gemini CLI：`google-gemini/gemini-cli` 仓库 `docs/tools/mcp-server.md`、`docs/hooks/index.md`、`docs/hooks/reference.md`、`docs/cli/skills.md`。本机 spike 于 0.68.0 npm bundle 直读源码：hook 事件枚举与 `hookSpecificOutput.additionalContext` → `<hook_context>` 注入路径（交互式 `addHistory`、`-p` headless 拼进 prompt）、`enableHooks ?? true`、hook `timeout` 毫秒（`DEFAULT_HOOK_TIMEOUT = 60000`）、`disabledHooks` 按 `name` 禁用、工具名 `mcp_<server>_<tool>`（`MCP_TOOL_PREFIX = "mcp_"` + `_` 分隔）、可信文件夹 + 条目 `trust` 免逐次确认、项目级 hook 走 `trusted_hooks.json`（未信任只警告仍执行）、skill 根 `~/.gemini/skills` + `~/.agents/skills`。
- Hermes：本机安装（`%LOCALAPPDATA%\hermes`，Nous Research `hermes_agent` 0.0.0 editable 源码树）直读：`tools/mcp_tool_config.py` + `mcp_tool_transport.py`（`command/args/env`、`url/headers`、`transport: "sse"`、`connect_timeout`、`enabled`、`${VAR}` 展开）、`tools/mcp_tool_schema.py`（`mcp__<server>__<tool>` 命名）、`agent/shell_hooks.py` + `hermes_cli/hooks.py`（hooks 事件集、stdin 载荷、`{"context": ...}` 输出、`shell-hooks-allowlist.json` 同意机制、timeout 秒制默认 60）、`agent/turn_context.py`（`pre_llm_call` 的 context 注入 user 消息路径）、`agent/conversation_loop.py`（`on_session_start` 返回值被丢弃=纯通知）、`agent/skill_utils.py`（tier: project `.hermes/skills`+`.agents/skills` > `~/.hermes/skills` > create_dir > `skills.external_dirs`）、`agent/context_file_sources.py`（SOUL.md / AGENTS.md 上下文文件）。
- OpenCode：官方文档 `opencode.ai/docs`（config 位置与 `mcp`/`mcp.servers` 形状、`type: "local"/"remote"`、`{env:VAR}`、系统目录 `%ProgramData%\opencode`、instructions 数组与 AGENTS.md 加载顺序、skills 目录）、`opencode mcp add/list/auth/debug` CLI、插件文档（`.opencode/plugins/` 与 `~/.config/opencode/plugins/`、事件订阅无注入通道、v2 `ctx.session.hook("prompt")` 与 `ctx.skill.transform`）、issue #5409（SessionStart hook 开放中）、`<server>_<tool>` 归一化与 Code Mode `tools.<server>.<tool>()`（v2 迁移说明）。本机未安装，标"待实机确认"的格子不得凭印象实现。

标"未验证"的格子不得凭印象实现：做对应宿主的适配时先补证据（官方文档或源码），再填 `agents/<host>/host.json`。

## 4. 各宿主做法

### 4.1 通用步骤（A1）

```bash
npm i -g http://<hub-host>:8424/dl/ck.tgz               # Node ≥ 20；产物由 hub 托管，版本与 hub 一致
ck login --hub http://<hub-host>:8424                   # 从 stdin 读 key，auth/verify 通过后写入 ~/.cinlan-knowledge/
ck setup --host <host> --agent <team>/<name>            # 只打印将要写入的内容
ck setup --host <host> --agent <team>/<name> --write    # 写入；被改的文件先备份为 .bak
ck doctor --host <host>
```

- 一台机器一把 key；每个宿主一个 Agent 名（如 `cinlan/dsh-ly`、`cinlan/cc-ly`），配装与用量因此可以按宿主区分。
- `ck setup` 写进宿主配置的命令一律是 `node <ck 入口绝对路径> …`，不依赖 PATH 与 `.cmd` 包装。下文用 `<ck>` 代表这个绝对路径。
- 手工接入：照 `agents/<host>/README.md` 把同一份模板抄进宿主配置，效果相同。

### 4.2 dsh（DeepSeek Harness）

`$DSH_HOME/profiles/<name>/cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）：

```yaml
- insert:
    - id: cinlan-knowledge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ck
        transport: stdio
        command: node
        args: ['<ck>', 'mcp', '--host', 'dsh', '--agent', 'cinlan/dsh-ly', '--baseline', 'full']
```

- baseline 走 `instructions`：dsh 把它原文放进系统提示，从第一个请求起就在，不受上下文压缩影响。全文封顶 24,000 字节，低于 dsh 的 32,768 上限。
- 不用 hook 桥接：它是 experimental，且 `SessionStart` 可能错过首个请求。
- **`ck setup` 只写默认位置** `~/.dsh/cordis.patch.yml`（2026-11-14 拍板）：不展开 `$DSH_HOME`、不处理 profile。设了变量或用 profile 的，dry-run 看过生成的块后手工挪到目标文件（cinlan-harness 的 `~/.clh/cordis.patch.yml` 同此）。
- skill 物化到 `~/.agents/skills`，dsh 默认发现，不需要改 `customSkillDirs`。
- dsh 的 stdio 协商会先起一个临时探测进程再起正式进程，`ck mcp` 的启动动作因此必须幂等（见 [loadout.md](loadout.md) §6）。
- A0 写法（不装 `ck`）：`transport: streamable-http`，`url: 'http://<hub-host>:8424/mcp'`，`headers` 里放 `Authorization`、`x-ck-agent: cinlan/dsh-ly`、`x-ck-host: dsh`、`x-ck-baseline: full`。demo 记录过 Desktop 上 `!!js process.env.X` 不可靠，Desktop 用 stdio。
- 配装改了之后要重连 MCP（重启 dsh 或重载该插件行）才会刷新 `instructions`。

### 4.3 Claude Code

MCP 条目（参数已对照本机 2.1.310 的 `claude mcp add-json --help`）：

```bash
claude mcp add-json ck '{"command":"node","args":["<ck>","mcp","--host","claude-code","--agent","cinlan/cc-ly"]}' --scope user
```

`~/.claude/settings.json` 里的 hook：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          { "type": "command", "command": "node \"<ck>\" hook session-start --host claude-code --agent cinlan/cc-ly" }
        ]
      }
    ]
  }
}
```

- 完整读档由 hook 送达；`compact` 在 matcher 里，压缩后会重新注入。`resume` 不在 matcher 里：恢复的会话历史里已经有 baseline。
- hook 的预算是 8,000 字符：Claude Code 把超过 10,000 字符的 hook 输出改存文件，只留 2,000 字符预览（[loadout.md](loadout.md) §4）。
- `instructions` 只放 `brief`（≤ 1,500 字符），不受 4,096 字符截断影响。
- skill 物化到 `~/.claude/skills`。该目录有热加载；hook 在有变更时返回 `reloadSkills: true`，本会话即可见（字段位置在 S2 确认）。
- A0 写法：`claude mcp add --transport http ck http://<hub-host>:8424/mcp --header "Authorization: Bearer …" --header "x-ck-agent: cinlan/cc-ly"`。key 会落进宿主配置，优先用 `headersHelper`。

### 4.4 Codex CLI 与 Gemini CLI（P2）

Codex，`~/.codex/config.toml`：

```toml
[mcp_servers.ck]
command = "node"
args = ["<ck>", "mcp", "--host", "codex", "--agent", "cinlan/codex-ly"]
```

Codex 的 hook 条目已定稿（见 `agents/codex/`）：`~/.codex/hooks.json` 的 `hooks.SessionStart`，输出与 Claude Code 同形（`hookSpecificOutput.additionalContext`）；`ck setup` 顺带把 `hooks.state` 信任表写进 config.toml 的同一个标记块。

### 4.5 Gemini CLI（P2，已适配）

`~/.gemini/settings.json` 一份 JSON 装两样：

```json
{
  "mcpServers": {
    "ck": {
      "command": "node",
      "args": ["<ck>", "mcp", "--host", "gemini-cli", "--agent", "cinlan/gemini-ly"],
      "trust": true
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "name": "cinlan-knowledge",
            "command": "node \"<ck>\" hook session-start --host gemini-cli --agent cinlan/gemini-ly",
            "timeout": 15000
          }
        ]
      }
    ]
  }
}
```

- 输出契约与 Claude Code 同形：`hookSpecificOutput.additionalContext` → gemini 转义 `<`/`>` 后包成 `<hook_context>` 的 user 消息注入（交互式 `addHistory`；`gemini -p` headless 前置进 prompt）。系统提示声明它是只读上下文。`ck hook` 不读 stdin，stdin JSON（`hook_event_name`/`session_id`/`cwd`/`source`）可忽略。
- 引擎默认开（`enableHooks` 缺省 `true`），**不需要** codex 那种 feature 开关；用户级 settings.json 的 hook 无信任审查（项目级 `.gemini/settings.json` 才走 `trusted_hooks.json`，且未信任只警告仍执行）。
- `timeout` 单位是**毫秒**（`DEFAULT_HOOK_TIMEOUT = 60000`），写 `15000`。`name` 是禁用键：`disabledHooks: ["cinlan-knowledge"]` 可单独关掉本条。
- SessionStart 的 `source` 只有 `startup / resume / clear`（压缩走独立 `PreCompress` 事件，不跟 SessionStart 的 matcher）；三种都注入以保住新会话与清空后的 baseline。
- 条目 `trust: true` + 工作区已在 `trustedFolders.json` → MCP 调用免逐次确认。未信任工作区里用户级 MCP server 整体停用，不是逐次问（2026-11-14 更正，0.68.0 `gemini mcp list` 实跑：未信任标 `Disabled` 并提示 `User-level servers are also suppressed in untrusted folders`，信任后 `Connected`）。
- 远端写法：`"type": "http"`、`"url"`、`"headers"`（x-ck-* 三个头，key 不进配置）。
- `ck setup` 对 settings.json 做单文件结构化合并：`mcpServers.ck` 与 `hooks.SessionStart` 合成一条变更落盘（两份合并若独立规划会互相覆盖）。
- skill 物化到 `~/.agents/skills`（gemini 同时扫 `~/.gemini/skills` 与 `~/.agents/skills`，选共享池与其他宿主共摊）。

### 4.6 Hermes（P2，已适配 `agents/hermes/`）

这里说的 Hermes 是 **Nous Research 的开源 Hermes**（`nousresearch.com` 遥测域名可证；本地 `%LOCALAPPDATA%\hermes` 实装，Python 包 `hermes_agent`），**不是腾讯系 CLI**——§3 矩阵旧行的"腾讯系"假设已更正。home 解析：POSIX `~/.hermes`、Windows `%LOCALAPPDATA%\hermes`（无点前缀，`HERMES_HOME` 可覆盖）；ck 声明若写 `~/.hermes` 在 Windows 会指到错的目录，适配时需要 env 展开或按平台声明。

`ck setup` 要动的三处都在同一个 `config.yaml`，且全是**嵌套键**（`mcp_servers` / `hooks` / `skills.external_dirs`）——ck 现有 YAML 能力是"尾部追加标记块"，追加第二个顶层 `mcp_servers:` 会造成重复键遮蔽（PyYAML 后者盖前者），所以接入前要补结构化 YAML 深合并，或者：

- **MCP**：`hermes mcp add ck --command node --args <ck 入口> mcp --agent <team>/<name>`（CLI 自己写回 `mcp_servers.ck`，安全）；远端 `url` + `headers`（默认 streamable-http，`transport: "sse"` 走旧 SSE）。`enabled`/`connect_timeout`/`${VAR}` 展开均支持。
- **hook**：`on_session_start` 的返回值在 `conversation_loop` 被丢弃，**不能注入上下文**——正确注入点是 `pre_llm_call`，stdin 载荷 `extra.is_first_turn === true` 时输出 `{"context": "<baseline>"}` 即可当 SessionStart 用（context 拼进 user 消息，不进系统提示）。条目形状：`hooks: {pre_llm_call: [{command, timeout}]} `，timeout 秒制默认 60。
- **同意**：shell hook 需 `shell-hooks-allowlist.json` 的 `{"approvals": [...]}` 里有 `{event, command, approved_at, script_mtime_at_approval}`（根必须是带 `approvals` 列表的对象，顶层列表按不可读处理），或 `hooks_auto_accept` / `HERMES_ACCEPT_HOOKS=1` / `--accept-hooks` / 交互批准。ck 可以像 codex `hooks.state` 一样代写 allowlist JSON（结构化合并即可）。
- **skill**：落 `~/.hermes/skills` 零配置；共享池路线是 `skills.external_dirs` 加 `~/.agents/skills`（需要又一处嵌套 YAML 合并）。
- **`instructions` 不采用**（源码无 MCP instructions 消费路径）→ `brief` + hook；`~/.hermes/SOUL.md` 是用户自撰上下文文件，不是托管点。工具名 `mcp__ck__knowledge_status`（与 Claude Code 同构）。

适配落地口径（2026-11-13）：不用 `hermes mcp add`（覆盖面只到 MCP，hook 与同意仍要手写同一份文件）——`ck setup` 对 `config.yaml` 做**行级结构化合并**（`mcp_servers.ck` + `hooks.pre_llm_call` 各并一条，`yamlcfg.ts` 不引 YAML 库、按缩进归一化比幂等/冲突），再代写 `shell-hooks-allowlist.json` 的 `{event: "pre_llm_call", command}`——command 与 YAML 里那行逐字符一致，`script_mtime_at_approval` 只是元数据。`pre_llm_call` 每轮 LLM 调用都触发：ck 侧读 stdin，`extra.is_first_turn !== true` 输出 `{}`。Windows home 用 `platforms.win32` 声明 `%LOCALAPPDATA%/hermes/...`，`expandHome` 支持 `%VAR%` 展开。`skills.external_dirs` 不写：skill 物化直接落 `~/.hermes/skills`（零配置可写根）。`--rules` 对 hermes 显式报错（SOUL.md 不是托管点）。

2026-11-14 更正（真 Hermes v0.23.0 对临时 `HERMES_HOME` 实跑 + `agent/shell_hooks.py` 核对）：allowlist 的根是 `{"approvals": [...]}`，之前代写成顶层列表，hermes 读作不可读，hook 标 `✗ not allowlisted` 不注册；已改为并入 `approvals`、保留根上其他键、形状不对报 conflict。`script_mtime_at_approval` 也不只是元数据：hermes 拿它和脚本当前 mtime 做字符串比较（`hermes hooks doctor` 的漂移告警，不拦执行），所以按 hermes 的 `script_mtime_iso` 格式写（UTC、整秒不带小数、否则 6 位微秒）。`ck doctor` 的 `approved` 改读 `approvals` 并按 (event, command) 全等判定。

### 4.7 OpenCode（P2，已适配 `agents/opencode/`，A1-lite）

这里是 **SST 的 OpenCode**（opencode.ai，`~/.config/opencode` 全局配置）。已按公开文档核对：

- **MCP**：`mcp.<name>`（v1；v2 归一化到 `mcp.servers`，v1 形状仍读）。`"type": "local"` 用 `command: ["node", "<ck 入口>", "mcp", "--host", "opencode", "--agent", "<team>/<name>"]`（**整条 argv 一个数组**，无 command/args 分写），`environment`、`enabled`、`timeout`（毫秒）、`cwd` 可选；远端 `"type": "remote"` + `url` + `headers`。`{env:VAR}` 插值；`opencode mcp add/list/debug` 可代写可自检。
- **`instructions` 采用**：进系统提示（权限拒掉该 server 全部工具时连 instructions 一并撤下），上限未验证 → `brief` 兜底。
- **会话开始注入**：**无配置式 shell hook**。插件是 TS/JS 进程内插件（`.opencode/plugins/`、`~/.config/opencode/plugins/`、npm `plugin: []`），`event` 订阅 `session.created`/`session.compacted` 等——`session.created` 在 init 后触发、不向上下文注入（SessionStart 注入 issue #5409 仍开放）。可行的 baseline 投递是 `instructions` 数组挂托管文件，或 `~/.config/opencode/AGENTS.md` 标记块；升级路径是 v2 `ctx.session.hook("prompt")` 插件在首条 prompt 入场前改 prompt。
- **skill**：`~/.config/opencode/skills/` 与项目 `.opencode/skills/` 发现；`ctx.skill.transform` 可程序化注册。
- **工具名** `<server>_<tool>`（非法字符归一化 `_`）：`ck_knowledge_status`；v2 默认 Code Mode 包成 `tools.ck.knowledge_status()`，`codemode: false` 走 provider 原生工具表。
- **待实机确认**：本机未装 opencode；v1/v2 `mcp` vs `mcp.servers` 兼容、Code Mode 下工具可用性、prompt hook 形状。

适配落地口径（2026-11-14）：`mcp.ck` 用声明新字段渲染——`mcp.argv: true` 把 stdio 条目写成 `{"type":"local","command":["node",<ck>,"mcp",…]}` 整条 argv 数组，`mcp.remote_type: "remote"` 覆盖 http 条目的 `type` 值；`doctor` 的 agent 提取泛化到 `entry.args` 或 argv `command` 数组、远端条目认 `x-ck-agent` 头。`hook: null`：baseline 走 MCP `instructions`（`brief`，进系统提示），`--rules` 写 `~/.config/opencode/AGENTS.md` 标记块兜底（`knowledge_status reload:true` 提示）；skill 物化 `~/.config/opencode/skills/`。`.jsonc` 注释文件不支持——`ck setup` 只合并纯 JSON（解析失败报 conflict，不覆盖）。panel guide 分组翻 ready。

### 4.8 通用 MCP 宿主

1. 有 Node：加一条 stdio 条目，`command = node`，`args = [<ck>, mcp, --host <名字>, --agent <team>/<name>]`。
2. 没有 Node：加一条远端条目指向 `http://<hub-host>:8424/mcp`，带 `Authorization`、`x-ck-agent`、`x-ck-host` 三个请求头。
3. 宿主是否采用 `instructions` 不确定时，在它的规则文件（`AGENTS.md` 一类）加一行："会话开始先调用 `knowledge_status`（`reload: true`）读取团队配装。"`ck setup --rules` 可以代写，写入的块有起止标记，可整块移除。

## 5. `ck`

客户端唯一的可执行文件。零业务逻辑：权限、预算、文本都在 hub。

| 命令 | 作用 |
| --- | --- |
| `ck login --hub <url>` | 从 stdin 读 key（不走命令行参数），`auth/verify` 通过后写 `~/.cinlan-knowledge/config.json` 与 `key` |
| `ck setup --host <h> --agent <team>/<name> [--transport stdio\|http] [--rules] [--write]` | 生成宿主配置改动：MCP 条目、hook 条目（宿主支持时）。默认只打印；`--write` 才落盘并备份 |
| `ck mcp --host <h> --agent <team>/<name> [--baseline brief\|full]` | stdio MCP server：五个工具 + `instructions` |
| `ck hook session-start --host <h> --agent <team>/<name>` | 输出宿主格式的 hook JSON（完整读档） |
| `ck skills sync --host <h> --agent <team>/<name>` | 手动物化 skill（平时由 `mcp` / `hook` 启动时顺带做） |
| `ck import --source <h> [--team <slug>] [--workspace <dir>] [--yes] [--update] [--dry-run]` | 把本机已有 skill 导入为自己的私有资产（P2，§8） |
| `ck doctor [--host <h>]` | 自检：hub 连通、key、Agent、resolve、宿主配置（条目存在且指向本机 ck）、hook 条目（codex 连信任表复算）、skill 目录（存在且可写，或父目录可创建）、缓存状态（通报项，不计成败）、版本是否与 hub 一致 |
| `ck rpc <动作> '<json>'` | 调任意 API 动作（运维与脚本用） |

- 本机文件都在 `~/.cinlan-knowledge/`（可用 `CK_HOME` 改）：`config.json`（hub 地址，无密钥）、`key`（一行，仅本人可读）、`cache/`、`logs/`。
- 取值顺序：环境变量 `CK_HUB_URL` / `CK_USER_KEY` 优先，其次本机文件。
- `ck setup` 对 JSON 配置做结构化合并；对 TOML / YAML 追加一段带起止标记的块，重复执行不重复写。条目名 `ck`（及标记块）归 ck 所有：重复执行原地更新、不重复追加，内容不同也不报冲突（换 `--agent` 重跑即此路径，2026-11-14 拍板）。真正的冲突只剩结构性问题：文件不是合法 JSON、`hooks.<event>` 不是列表、allowlist 根形状不对、yaml / toml 块外已有同名 id / 表——此时不覆盖、打印差异并退出。一次执行要么全写要么不写：涉及的文件里任何一个报冲突，其余文件也不落盘（输出 `nothing written: …`，exit 1），不留半接入状态（2026-11-14 拍板）。

## 6. `agents/<host>/` 约定

```
agents/
  README.md            宿主清单（本文 §3 的可执行版）
  <host>/
    README.md          接入手册：手工步骤、验收、排错
    host.json          声明：配置文件位置与格式、默认 baseline 方式、各送法的预算（字符与字节）、
                       hook 输出形状、skill 目录、可导入资产的扫描位置
    templates/         MCP 条目与 hook 条目模板（占位符 {{CK_ENTRY}} {{HUB_URL}} {{AGENT}}）
```

- 构建时整个 `agents/` 打进 `ck` 产物；`ck setup`、`ck skills`、`ck import` 只读这些声明与模板。
- 目录里不放业务逻辑。宿主之间的差异如果声明表达不了，先改声明的字段设计，不在 `ck` 里写宿主分支。
- A2 原生插件（如果某个宿主将来要做）放 `agents/<host>/plugin/`，单独立项。

## 7. 新增一个宿主

要回答六个问题，每个都要有官方文档或源码出处：

1. MCP 条目写在哪个文件、什么形状？（stdio 必答，远端可选）
2. 是否采用 `instructions`，放在哪，上限多少、按字符还是字节？→ 决定 `full` / `brief`
3. 有没有会话开始 hook，输出什么格式、上限多少，压缩后是否重跑？→ 决定是否走 hook 与 hook 的预算
4. skill 目录在哪、目录形状如何、要不要重启才发现？
5. 本机可导入的资产在哪？
6. 工具名前缀是什么形态？（只用于文档与排错）

交付物：`agents/<host>/` 三件套 + `ck setup` 的 golden 测试（给定输入配置 → 期望输出配置）+ 实机验收四项（[install.md](install.md) §7 的宿主侧清单）。六个问题里有答不上的，对应能力降一档（hook → `instructions` → `tool`），不猜。

## 8. 本机资产导入（P2）

做法取自腾讯的 `agents/asset-import.ts --source <host>`：新成员把已有积累带进来。

```bash
ck import --source claude-code            # 交互：列出候选 → 全部 / 部分 / 不导入
ck import --source dsh --workspace D:/repo --yes
```

| 来源 | 扫描位置 |
| --- | --- |
| `claude-code` | `~/.claude/skills/*/SKILL.md`、`<workspace>/.claude/skills/*/SKILL.md` |
| `codex` | `~/.agents/skills`、`<workspace>/.agents/skills` |
| `dsh` | `<workspace>/.dsh/skills`、`<workspace>/.agents/skills`、`$DSH_HOME/skills`、`~/.agents/skills` |
| `cinlan-harness` | `<workspace>/.clh/skills`、`<workspace>/.agents/skills`、`$CLH_HOME/skills`、`~/.agents/skills` |
| `gemini-cli` | `~/.gemini/skills`、`~/.agents/skills`、`<workspace>/.gemini/skills`、`<workspace>/.agents/skills` |
| `hermes` | `~/.hermes/skills`（Windows 为 `%LOCALAPPDATA%/hermes/skills`）、`~/.agents/skills`、`<workspace>/.hermes/skills`、`<workspace>/.agents/skills` |
| `opencode` | `~/.config/opencode/skills`、`~/.agents/skills`、`<workspace>/.opencode/skills`、`<workspace>/.agents/skills` |

本表是 `agents/<host>/host.json` 里 `import_scan` 的抄本，以声明为准（2026-11-14 按声明重写）。每个位置只看一层子目录（`<位置>/<dir>/SKILL.md`）；`$VAR` / `%VAR%` 未设置或目录不存在记一条提示后跳过。

已知缺口（声明表达不了，`ck import` 扫不到，需要的先手工拷到上表任一位置）：

- codex 会从 git 根逐级到当前目录找 `.agents/skills`；`ck import` 只看 `<workspace>/.agents/skills` 这一层。
- dsh / cinlan-harness 配置里的 `customSkillDirs`：`ck import` 不读宿主配置，这些目录不在扫描范围。

规则：

- 只导入 skill（目录含 `SKILL.md`）。会话 → 记忆的抽取需要 LLM，归 P3 的自动沉淀。
- 导入结果是**本人的 private 资产**，想给团队用再走共享审批。
- 带 `.cinlan-knowledge.json` 标记的目录跳过：那是从 hub 物化出来的，不是本地原创。
- 资产名取 `SKILL.md` frontmatter 的 `name`，目录名不参与。`description` 写成单行或块标量（`description: >-` 折叠、`|` 保留换行）都认，取折叠后的文本做摘要；frontmatter 缺失、`name` 不是合法 slug、`description` 为空的目录跳过并计入 `Skipped`。
- 幂等在 hub 侧（`asset/import`）：按"本人名下的同名 skill"匹配。没有 → 新建；有且内容相同 → `unchanged`；有但内容不同 → 默认报 `conflict` 不动，带 `--update` 才出新版本。内容是否相同由 hub 用 `content_hash` 判断，客户端不算 hash。
- 团队归属（`asset/import` 必填 team）：`--team <slug>` 显式指定；未给时按 `auth/verify` 的团队列表——唯一自动选、多个报错列出并要求 `--team`、零个报错。
- 批处理纪律：逐条顺序提交并限速；网络错误与 429 指数退避重试，4xx 其余记失败并继续；结束输出 `Total / Success / Failed / Skipped` 与失败原因。
- 断点续跑靠 hub 幂等，本机不留进度文件（2026-11-14 拍板）：中断后原样重跑，已导入的条目返回 `unchanged`、不产生新版本，没导入的继续新建。代价是重跑会把已完成的条目再提交一遍（每条一次请求，受限流约束）。
