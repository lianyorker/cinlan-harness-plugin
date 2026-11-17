# Hermes 接入（`--host hermes`）

适用：Nous Research 的开源 Hermes agent CLI（Python，`hermes_agent` 包）。**不是腾讯系 CLI**。spike 证据见 `docs/hosts.md` §3 矩阵与 §4.6。

## 宿主事实

| 项 | 值 |
| --- | --- |
| home | POSIX `~/.hermes`；Windows `%LOCALAPPDATA%\hermes`；`HERMES_HOME` 可覆盖（`ck setup` / `ck doctor` 不跟这个变量，只读写默认位置；设了的手工把 `config.yaml` 的条目与批准表挪过去） |
| 配置文件 | `<HERMES_HOME>/config.yaml`——MCP 与 hooks 同一份 YAML |
| MCP 键 | `mcp_servers.ck`；stdio 写 `command`/`args`，远端写 `url` + `headers`（默认 streamable-http） |
| MCP 工具名 | `mcp__ck__knowledge_status`（`mcp__<server>__<tool>`，与 Claude Code 同构） |
| hook 事件 | `pre_llm_call`（每个 LLM 调用都触发；`on_session_start` 的返回值被丢弃，**不能**注入） |
| hook 条目 | `hooks.pre_llm_call` 列表，元素 `{command, timeout}`（timeout 秒制，默认 60，范围 1–300） |
| hook stdin | JSON 载荷：`hook_event_name` + `extra.is_first_turn` 等字段 |
| 注入契约 | stdout `{"context": "<非空字符串>"}` → 拼进 user 消息（不进系统提示） |
| 首轮门控 | `pre_llm_call` 无 matcher；ck 侧读 stdin，`extra.is_first_turn !== true` 输出 `{}` |
| shell hook 批准 | `<HERMES_HOME>/shell-hooks-allowlist.json`，根是 `{"approvals": [...]}`（顶层列表 hermes 按不可读处理，hook 不注册），逐条按 `(event, command)` **逐字符精确匹配**；`script_mtime_at_approval` 不参与匹配，hermes 拿它和脚本当前 mtime 做字符串比较判「批准后脚本是否改过」（`hermes hooks doctor` 的告警，不拦执行），格式是 UTC、整秒不带小数、否则 6 位微秒 |
| 全局豁免 | `hooks_auto_accept` / `HERMES_ACCEPT_HOOKS=1` / `--accept-hooks`——**ck 不启用**，改用代写 allowlist |
| skill 目录 | `~/.hermes/skills` 零配置可放；共享池走 `skills.external_dirs`（未自动合并） |
| 规则文件 | 无托管点：`SOUL.md` 是用户自撰上下文文件，`ck setup --rules` 对 hermes 会报错 |

## 一键接入

```powershell
node <repo>\packages\cli\lib\bin.js setup --host hermes --agent <team>/<name>
node <repo>\packages\cli\lib\bin.js setup --host hermes --agent <team>/<name> --write
```

`--write` 做三件事：

1. `config.yaml` 一次结构化合并：`mcp_servers.ck` + `hooks.pre_llm_call` 一条变更落盘（先生成 `.bak`），不是尾部追加——追加会造成重复顶层键遮蔽。
2. `shell-hooks-allowlist.json` 的 `approvals` 列表追加 `{event: "pre_llm_call", command: <与 config.yaml 逐字符一致>, approved_at, script_mtime_at_approval}`，根上其他键原样保留；同 (event, command) 已存在则 `unchanged`；根不是 `{"approvals": [...]}` 报 `conflict` 不覆盖。
3. 任何一处报 `conflict`，这次执行一个文件都不写（`nothing written: …`，exit 1）：`config.yaml` 冲突时不写批准表——批准一个没接线的命令只会误导排查；批准表冲突时也不写 `config.yaml`——接了线却没批准的 hook 不会跑。

重复执行幂等 `unchanged`；手工改过的同名条目报 `conflict` 不覆盖。

## 手工抄写（不跑 ck setup）

按 `templates/` 抄进 `config.yaml`（并入**既有**顶层 `mcp_servers:` / `hooks:` 段，不要复制出第二个顶层键）：

- `mcp.yaml` → `mcp_servers.ck`（stdio）
- `mcp.http.yaml` → `mcp_servers.ck`（远端；key 不进配置，header 走宿主自己的鉴权机制）
- `hook.yaml` → `hooks.pre_llm_call` 列表追加一项
- 手工接入还要自己往 `shell-hooks-allowlist.json` 的 `approvals` 列表加一条 `{event, command}`——command 与 YAML 里那行逐字符一致，否则 hook 永远不跑

## 验收

- `node <ck> doctor --host hermes`：`host_config`（从 `mcp_servers.ck` 解出 agent）、`hook`（hook_present + approved）、`skill_dir` 均 ok。
- `hermes hooks doctor`：`✓ allowlisted`、`✓ script unchanged since approval`、`✓ produced valid JSON on synthetic payload`（批准是否生效以 hermes 自己的判定为准）。
- Hermes 新会话首轮提问时配装文本拼进 user 消息；第二轮起 `pre_llm_call` 输出 `{}`。
- `mcp__ck__knowledge_status` 工具可达。

## 排障

- **hook 没跑**：先跑 `hermes hooks list`，条目标 `✓ allowed` 才会执行；`✗ not allowlisted` 就查 allowlist——`(event, command)` 必须逐字符匹配；改过 `--agent` 或 ck 路径后两边要同步重跑 setup。
- **每次都注入**：ck 首轮门控依赖 stdin 的 `extra.is_first_turn`；拿不到该字段时输出 `{}`（宁可不注，不刷每轮）。
- **`ck setup --rules` 报错**：hermes 没有托管规则文件点；要写 SOUL.md 自己动手。
