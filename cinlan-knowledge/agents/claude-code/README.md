# Claude Code 接入手册

期：P1。方式：A1 —— stdio MCP + `SessionStart` hook 读档；`instructions` 只放 `brief`。

## 事实（出处见 docs/hosts.md §3）

| 项 | 事实 | 出处 |
| --- | --- | --- |
| MCP 条目 | `claude mcp add-json ck '<json>' --scope user`，或直接写 `~/.claude.json` 的 `mcpServers.ck` | `claude mcp add --help` / `add-json --help`（2.1.310） |
| 远端 | `--transport http` + `--header`；有 `headersHelper` 可避免 key 落盘 | 同上 |
| 工具名 | `mcp__ck__<tool>` | 宿主行为 |
| instructions | 采用，默认截断到 4,096 字符（`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 可调） | `anthropics/claude-code` `CHANGELOG.md` |
| hook | `SessionStart`（`startup / clear / compact`），`hookSpecificOutput.additionalContext` 进上下文；超过 10,000 字符改存文件、只留 2,000 字符预览 | 同上 |
| hook 预算 | 8,000 字符（`host.json` `budgets.hook`），低于宿主的 10,000 阈值 | 本仓库约定 |
| skill 目录 | `~/.claude/skills`、项目 `.claude/skills`；有热加载 | `CHANGELOG.md` |

`resume` 不放进 matcher：恢复的会话历史里已经有 baseline，重复注入没有意义。

## 手工接入

MCP 条目：

```bash
claude mcp add-json ck '{"command":"node","args":["<ck>","mcp","--host","claude-code","--agent","<team>/<name>"]}' --scope user
```

hook 条目写进 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          { "type": "command", "command": "node \"<ck>\" hook session-start --host claude-code --agent <team>/<name>" }
        ]
      }
    ]
  }
}
```

或直接用 [templates/mcp.json](templates/mcp.json) 与 [templates/hook.session-start.json](templates/hook.session-start.json)，替换 `{{CK_ENTRY}}`、`{{AGENT}}`。

等价命令：

```bash
ck setup --host claude-code --agent <team>/<name> --write
```

`ck setup` 对 `~/.claude.json` 做结构化合并：`mcpServers.ck` 已存在且内容相同 → 不动；内容不同 → 报冲突、不覆盖。对 `~/.claude/settings.json`：同 matcher 的组里已有别的 hook → 追加，已有另一条 ck `session-start` → 报冲突。两个文件里任何一个报冲突，这次执行都不落盘（`nothing written: …`，exit 1）；按输出里的 current / wanted 处理掉冲突后重跑。

远端 hub（不装 `ck`）时用 [templates/mcp.http.json](templates/mcp.http.json)；key 走 `headersHelper`，不写死进配置。

## 验收

- `ck doctor --host claude-code` 全绿，能从 `~/.claude.json` 的 `mcpServers.ck.args` 解析出 Agent 名。
- 新开一个会话：hook 注入可见（会话开始即有 `<cinlan_knowledge …>` 文本），`/compact` 之后重新出现。
- 调用 `mcp__ck__knowledge_status`：`ok: true`、`agent` 正确、`items` 非空、`stale: false`。
- 团队约定问答答对。
- 用另一个 key 的会话存一条，本会话搜不到。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 会话开始没有注入，但工具可用 | hook 没落盘或 matcher 不匹配。`ck setup --host claude-code`（不带 `--write`）对照打印结果与 `~/.claude/settings.json` |
| 注入文本被截成预览 | hook 输出超过 10,000 字符。`ck` 按 8,000 字符预算提前降级，超限说明预算被改大；改回 `host.json` 的 `budgets.hook` |
| 工具在，模型不按团队约定答 | `instructions` 被截到 4,096 字符——`brief` 本身 ≤ 1,500，正常不会。确认配装文本确实是 `brief`；`full` 请留给 hook |
| `ck setup` 报 `mcpServers.ck exists with different content` | 之前手工加过同名条目。对比打印的 `current` / `wanted`，手工删旧的再加 |
| skill 更新了本会话看不到 | 该目录支持热加载；`reloadSkills` 字段位置待 S2 确认，当前靠下一次会话生效，或 `/clear` 后重新注入 |
| Windows 上 hook 不执行 | 检查 `~/.claude/settings.json` 里命令的路径转义；统一用 `node "<ck>" …` 形式 |
