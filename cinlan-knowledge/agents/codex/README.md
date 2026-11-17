# Codex CLI 接入手册

期：P2。方式：A1 —— stdio MCP + `SessionStart` hook 读档；`instructions` 只放 `brief`。

## 事实（出处见 docs/hosts.md §3，本机 codex-cli 0.166.0 实机 spike）

| 项 | 事实 | 出处 |
| --- | --- | --- |
| MCP 条目 | `~/.codex/config.toml` 的 `[mcp_servers.ck]`：`command / args`；远端 `url` + `bearer_token_env_var` / `http_headers` | `openai/codex` `codex-rs/config/src/mcp_types.rs` |
| 工具名 | `mcp__ck__<tool>`（code mode 下 `await tools.mcp__ck__<tool>(...)`） | 0.166.0 会话 base instructions 实证 |
| instructions | **不作指令级指导**：降级为工具命名空间元数据，模型不可见为指令 | `openai/codex` issues #29097（源码分析）/ #6148（官方关闭） |
| hook 开关 | hooks 引擎是 stable feature，默认关：`codex features enable hooks` | 0.166.0 `codex features list` |
| hook 落点 | `~/.codex/hooks.json` 或 config.toml 的 `[hooks]`；`SessionStart` 的 source 有 `startup / resume / clear / compact / fork` | `codex-rs/hooks`、`learn.chatgpt.com/docs/hooks`、实机验证 |
| hook 输入 | stdin JSON：`session_id / transcript_path / cwd / hook_event_name / model / permission_mode / source` | 实机 spike 捕获 |
| hook 输出 | `hookSpecificOutput.additionalContext` 进模型上下文（developer 消息，`hooks.additional_context`），与 Claude Code 同形 | 实机 spike 验证 |
| hook 信任 | 非托管 hook 须审查：`/hooks` TUI 手动信任，或预写 `config.toml` 的 `[hooks.state.'<hooks.json 路径>:session_start:<组>:<项>']`（`enabled` + `trusted_hash`）；`ck setup --write` 代写 | `codex-rs/hooks/src/engine/discovery.rs`、实机验证 |
| skill 目录 | `~/.agents/skills`（递归发现）、项目 `.agents/skills`；内置 `<CODEX_HOME>/skills/.system` | 0.166.0 rollout 的 skills_instructions 实证 |
| hook 预算 | 8,000 字符（`host.json` `budgets.hook`） | 本仓库约定 |

`resume` / `fork` 不放进 matcher：恢复与分叉的会话历史里已有 baseline，重复注入没有意义。

## 手工接入

前置（一次性）：`codex features enable hooks`

`~/.codex/config.toml` 追加 [templates/mcp.toml](templates/mcp.toml) 的块；`~/.codex/hooks.json` 写 [templates/hooks.json](templates/hooks.json) 的 `hooks.SessionStart` 条目，替换 `{{CK_ENTRY}}`、`{{AGENT}}`。

手工抄 hook 后还需在 TUI `/hooks` 里审查信任一次；或按 `codex-rs` 的 `command_hook_hash` 规则自算 `sha256` 写 `[hooks.state.'<hooks.json 绝对路径>:session_start:<组下标>:<项下标>']`（`enabled = true` + `trusted_hash`）。

等价命令：

```bash
ck setup --host codex --agent <team>/<name> --write
```

`ck setup` 对 `~/.codex/config.toml` 追加带标记的块（`[mcp_servers.ck]` + `[hooks.state.*]` 信任表）；块外已有 `[mcp_servers.ck]` → 报冲突、不覆盖。对 `~/.codex/hooks.json` 做结构化合并：同 matcher 的组里已有别的 hook → 追加。两个文件里任何一个报结构性冲突（不是合法 JSON 等），这次执行都不落盘（`nothing written: …`，exit 1）。换 `--agent` 重跑不是冲突：条目归 ck 所有，config.toml 的标记块与 hooks.json 的条目都原地更新成新 Agent，信任表按新命令重算。写完只剩 `codex features enable hooks` 一步（setup 输出会提示）。

远端 hub（不装 `ck`）时用 [templates/mcp.http.toml](templates/mcp.http.toml)；key 走 `bearer_token_env_var = "CK_USER_KEY"`（与 `ck` 自己读的变量同名），不写死进配置。

`ck setup` / `ck doctor` 只读写默认的 `~/.codex`；设了 `CODEX_HOME` 的，手工把 `config.toml` 的标记块与 `hooks.json` 的条目挪到 `$CODEX_HOME` 下（`[hooks.state.*]` 的键里带 `hooks.json` 的绝对路径，挪了位置键要跟着改，或在 `/hooks` 里重新信任一次）。

## 验收

- `ck doctor --host codex` 全绿。
- 新开一个会话：hook 注入可见（会话开始即有 `<cinlan_knowledge …>` 文本），`/compact` 之后重新出现。
- 调用 `mcp__ck__knowledge_status`：`ok: true`、`agent` 正确、`items` 非空、`stale: false`。
- 团队约定问答答对。
- 用另一个 key 的会话存一条，本会话搜不到。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 会话开始没有注入，工具也没有 | hooks 引擎没开：`codex features enable hooks` |
| 会话开始没有注入，工具可用 | hook 未信任：`/hooks` 里看到待审查项就信任它；`ck setup --write` 已预写 `hooks.state` 的，检查 hooks.json 是否被手改过（下标漂移会失效）。`ck doctor --host codex` 的 `hook` 项会指出是哪一环：`hook_present` / `trust_entry_present` / `trust_enabled` / `trusted_hash_matches` |
| `instructions` 里写了内容模型却看不到 | 已知宿主行为：codex 只把它当工具元数据，不是缺陷；baseline 靠 hook/`tool` 送 |
| `ck setup` 报 `[mcp_servers.ck] already exists outside` | 之前手工加过同名表。删掉旧的或并入 ck 块 |
| skill 更新了本会话看不到 | skill 目录按会话快照；下个会话生效 |
| `codex exec` 下 hook 不跑 | 检查 `features.hooks`；另可用 `--dangerously-bypass-hook-trust` 临时绕开信任验证排查 |
