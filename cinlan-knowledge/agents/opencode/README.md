# OpenCode 接入（A1-lite）

SST 的 OpenCode（opencode.ai）。无配置式 shell hook，baseline 走 MCP `instructions`（brief）+ `--rules` 的 `AGENTS.md` 标记块。

## 宿主事实

- 全局配置 `~/.config/opencode/opencode.json`（`.jsonc` 变体不支持注释合并——`ck setup` 只写纯 JSON 文件）。
- MCP 条目在顶层 `mcp.<name>`：v2 内部归一化到 `mcp.servers`，v1 形状仍读；`"type": "local"` 的 `command` 是**整条 argv 数组**（无 `command`/`args` 分写），远端是 `"type": "remote"` + `url`/`headers`。
- **`instructions` 采用**：MCP server 的 instructions 进系统提示（权限拒掉该 server 全部工具时连 instructions 一并撤下）→ `brief` 兜底。
- **无配置式 shell hook**：插件是进程内 TS/JS，`session.created` 在 init 后触发、不向上下文注入（上游 issue #5409 仍开放）。baseline 投递 = instructions + `~/.config/opencode/AGENTS.md` 标记块；升级路径是 v2 `ctx.session.hook("prompt")`。
- skill 发现根：`~/.config/opencode/skills/` 与项目 `.opencode/skills/`。
- 工具名 `<server>_<tool>`：`ck_knowledge_status`；v2 默认 Code Mode 包成 `tools.ck.knowledge_status()`，`codemode: false` 走原生工具表。

## 自动接入

```bash
ck login --hub http://<hub-host>:8424
ck setup --host opencode --agent <team>/<name> --rules --write
ck doctor --host opencode
```

- `ck setup --write`：往 `opencode.json` 合并 `mcp.ck`（`type: local` + argv `command`）；`--rules` 往 `AGENTS.md` 写带标记的说明块（可整块移除）；已有 `mcp.ck` 且内容不同 → 拒绝覆盖并打印差异。
- `ck setup --transport http`：写 `type: remote` 条目（`url` + 三个 `x-ck-*` 头）。
- `ck skills sync --host opencode --agent <team>/<name>`：物化团队 skill 到 `~/.config/opencode/skills/`。
- `ck doctor --host opencode`：配置存在性、从 argv 数组挖 `--agent`、skill 目录、hub/agent/resolve 探针。

## 手动接入

把 `templates/mcp.json` 的 `mcp.ck` 值抄进 `~/.config/opencode/opencode.json` 的顶层 `mcp` 下，`{{CK_ENTRY}}` 换成 ck 入口绝对路径、`{{AGENT}}` 换成 `<team>/<name>`。远端把 `templates/mcp.http.json` 的值抄进去并补 `Authorization` 头。

## 验收

1. `ck setup --host opencode --agent core/oc-test --write` → `opencode.json` 新增 `mcp.ck`，已有键零改动。
2. `opencode mcp list` 列出 `ck`，`opencode mcp debug ck` 连通。
3. 新会话：系统提示含 brief baseline；`ck_knowledge_status`（Code Mode 下 `tools.ck.knowledge_status()`）返回团队配装。
4. `ck skills sync` 后 `~/.config/opencode/skills/` 出现团队 skill。

待实机确认（本机未装 opencode）：v1/v2 `mcp` vs `mcp.servers` 兼容、Code Mode 下工具可用性、prompt hook 形状。

## 排错

- **`mcp.ck` 存在但报 conflict**：已有条目内容不同，`ck setup` 不覆盖——对照 detail 里的 current/wanted，手动改一致或删掉旧条目重跑。
- **`.jsonc` 带注释**：`ck setup` 只合并纯 JSON；带注释的文件先手动去掉注释，或把 `mcp.ck` 按模板手抄。
- **工具名找不到**：v2 Code Mode 下是 `tools.ck.knowledge_status()`；`codemode: false` 时是 `ck_knowledge_status`。
