# Gemini CLI 接入（`--host gemini-cli`）

适用：Gemini CLI ≥ 0.68（`npx @google/gemini-cli --version` 或全局安装）。本机 spike 基于 0.68.0 产物（npm bundle 源码直读）。

## 宿主事实

| 项 | 值 |
| --- | --- |
| 配置文件 | `~/.gemini/settings.json`（MCP 与 hooks 同一份 JSON） |
| MCP 键 | `mcpServers.ck`；stdio 写 `command`/`args`，远端写 `type:"http"` + `url` + `headers` |
| MCP 工具名 | `mcp_<server>_<tool>`（`mcp_ck_knowledge_status` 等 5 个；不是 `mcp__` 双下划线） |
| 调用确认 | 条目里 `trust: true` + 工作区已信任 → 免逐次确认 |
| 工作区信任 | 未信任的工作区里 **用户级 MCP server 也整体停用**（`gemini mcp list` 标 `Disabled`，并提示 `User-level servers are also suppressed in untrusted folders`）；工作区进了 `~/.gemini/trustedFolders.json` 才连（0.68.0 实跑） |
| hook | `hooks.SessionStart` 数组，元素 `{matcher, hooks:[{type:"command", name, command, timeout}]}` |
| hook 引擎 | 默认开（`enableHooks` 缺省 `true`）；`disabledHooks` 数组按 name 禁用 |
| hook 信任 | **用户级 settings.json 无审查**；项目级 `.gemini/settings.json` 走 `~/.gemini/trusted_hooks.json`（未信任只警告仍执行） |
| hook 超时 | 毫秒（`DEFAULT_HOOK_TIMEOUT = 60000`）；我们写 `15000` |
| SessionStart source | `startup` / `resume` / `clear`（**无 compact**；压缩是独立 `PreCompress` 事件） |
| 注入契约 | hook stdout 的 `hookSpecificOutput.additionalContext` → `<hook_context>` 包裹成 user 消息（交互式 `addHistory`，`-p` headless 前置进 prompt）；`<` `>` 会被转义 |
| skill 目录 | `~/.gemini/skills` 与 `~/.agents/skills` 都扫；项目级 `.gemini/skills`。本适配用共享池 `~/.agents/skills` |
| 规则文件 | `~/.gemini/GEMINI.md`（`ck setup --rules` 写标记块） |

## 一键接入

```powershell
node <repo>\packages\cli\lib\bin.js setup --host gemini-cli --agent <team>/<name>
node <repo>\packages\cli\lib\bin.js setup --host gemini-cli --agent <team>/<name> --write
```

`--write` 对 `~/.gemini/settings.json` 做一次结构化合并（`mcpServers.ck` + `hooks.SessionStart` 一条变更落盘，先生成 `.bak`），重复执行幂等 `unchanged`，手工改过的同名条目报 `conflict` 不覆盖。

`ck setup` / `ck doctor` 只读写默认的 `~/.gemini`；设了 `GEMINI_CLI_HOME` 的，手工把 `settings.json` 里的两处条目挪到 `$GEMINI_CLI_HOME/.gemini/settings.json`。

## 手工抄写（不跑 ck setup）

按 `templates/` 抄进 `~/.gemini/settings.json`：

- `mcp.json` → `mcpServers.ck`（stdio）
- `mcp.http.json` → `mcpServers.ck`（远端；key 不进配置）
- `hooks.json` → `hooks.SessionStart`（追加到数组，别覆盖既有组）

## 验收

- `gemini mcp list`：`ck` 已注册。
- 新会话问「团队知识库基线里的验收暗号是什么」→ 应答出暗号（SessionStart hook 注入）。
- `gemini -p "调用 mcp_ck_knowledge_status 并复述 agent 名"` → 工具可达。
- `node <ck> doctor --host gemini-cli`：全部 ok（`host_config` 从 `mcpServers.ck` 的 args 里解出 agent，`hook` 项查 `hooks.SessionStart` 条目；检查项清单见 install.md §5）。

## 排障

- **hook 没跑**：settings.json 里 `enableHooks` 被显式设成 `false`，或本条目被加进了 `disabledHooks`。恢复/删除对应项即可。
- **只想关 ck 这条 hook**：`disabledHooks: ["cinlan-knowledge"]`（条目里的 `name` 就是禁用键）。
- **`ck` 工具不出现 / `gemini mcp list` 标 `Disabled`**：当前工作区未受信任，用户级 MCP server 被整体停用。在该目录里信任工作区（进 `~/.gemini/trustedFolders.json`）后重开。
- **每次调用都弹确认**：条目 `trust` 被删了。
- **stdin JSON 形状**：与 Claude Code 同构（`hook_event_name`、`session_id`、`cwd`、`source`），`ck hook` 不读 stdin 也能工作。
