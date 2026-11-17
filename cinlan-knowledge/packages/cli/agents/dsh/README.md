# dsh（DeepSeek Harness）接入手册

期：P1。方式：A1 —— stdio MCP + `instructions` 读档，不用 hook。

## 事实（出处见 docs/hosts.md §3）

| 项 | 事实 | 出处 |
| --- | --- | --- |
| MCP 条目 | `cordis.patch.yml` 的 `- insert:` 行，`name: '@deepseek-ai/dsh-mcp-client'`，`config.transport: stdio`（`command / args / env / cwd`）或 `streamable-http`（`url / headers`） | `packages/mcp/mcp-client/README.zh.md` |
| `serverName` | 必填，`[A-Za-z0-9_-]{1,32}`，同一注册作用域内唯一；工具名 `mcp__ck__<tool>` | 同上 |
| 配置层 | `$DSH_HOME/profiles/<name>/cordis.patch.yml` 只影响一个 profile；`$DSH_HOME/cordis.patch.yml` 影响全部；`DSH_HOME` 默认 `~/.dsh` | `docs/user/guide/mcp-memory.zh.md` |
| instructions | 服务器 `instructions` 原文进系统提示；上限 32,768 UTF-8 字节，超限连接失败 | `src/connection.ts` `DEFAULT_MAX_INSTRUCTION_BYTES` |
| stdio 启动 | 协商时先起一个临时探测进程，再起正式进程；`ck mcp` 的启动动作必须幂等 | `packages/mcp/mcp-client` |
| skill 目录 | `~/.agents/skills`（另可查 `$DSH_HOME/skills`、`customSkillDirs`、项目 `.dsh/skills` 与 `.agents/skills`，只下探一层） | `packages/skill/skill-filesystem/src/index.ts` |
| hook | 只有 experimental 的 `dsh-hooks-claude-code` / `dsh-hooks-codex` 桥接，`SessionStart` 可能错过首个请求 | `packages/experimental/hooks-claude-code/README.zh.md` |

`host.json` 里 `instructions: "full"`，预算 12,000 字符 / 24,000 字节——低于 32,768 上限，留出 `### MCP server: ck` 包装的余量。

## 手工接入

1. 选落点：只影响一个 profile 就写 `$DSH_HOME/profiles/<name>/cordis.patch.yml`；影响全部就写 `$DSH_HOME/cordis.patch.yml`。文件已存在时只追加，不覆盖。
2. 抄 [templates/mcp.patch.yml](templates/mcp.patch.yml)，把 `{{CK_ENTRY}}` 换成 `ck` 入口绝对路径（全局安装后一般是 `…/node_modules/@cinlan/knowledge-cli/lib/bin.js`），`{{AGENT}}` 换成 `<team>/<name>`。
3. 远端 hub 不装 `ck` 时用 [templates/mcp.http.patch.yml](templates/mcp.http.patch.yml)，`Authorization` 走宿主侧凭证或网关注入——key 不写进 patch 文件。
4. 重启 dsh，或重载该插件行。配装改过之后也要重连才会刷新 `instructions`。

等价命令：

```bash
ck setup --host dsh --agent <team>/<name> --write
```

`ck setup` 只维护自己那段 `# >>> cinlan-knowledge` 标记块；标记块之外出现同名 `id: cinlan-knowledge` 就报冲突、拒绝写入。

## 验收

- `ck doctor --host dsh` 全绿，能读出配置里的 Agent 名。
- dsh 会话里调用 `mcp__ck__knowledge_status`：`ok: true`、`agent` 是 `<team>/<name>`、`items` 非空、`stale: false`。
- 问一句只有团队约定才答得上的问题，模型答对 → `instructions` 确实进了系统提示。
- 用另一个 key 的会话调用 `knowledge_save` 存一条，本会话 `knowledge_search` 搜不到（权限生效）。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| dsh 启动后没有 `mcp__ck__*` 工具 | 初始连接失败时 dsh 照常启动，只记一条错误。查 dsh 日志，手工跑 `node <ck> mcp --host dsh --agent <t>/<n>` 看 stderr |
| 报 `serverName "ck" is already in use` | 同一作用域里还有别的 mcp-client 用了 `ck`；改到独立 agent 作用域，或让另一条换名 |
| 连接直接失败、报 instruction 过大 | 配装全文超过 32,768 字节。查 hub 侧 `loadout/resolve` 的 `bytes`；`ck` 按 24,000 截此不会发生，超限说明配装被手工改过 |
| 工具在，但模型不知道团队约定 | `instructions` 未刷新：重连插件行；或宿主把 `instructions` 放到了非首轮位置，改用 `knowledge_status(reload: true)` |
| 配了 Desktop 却连不上 | Desktop 上 `!!js process.env.X` 不可靠，stdio 不受影响；别在 Desktop 里靠环境变量传 key，用 `ck login` 落盘的 `~/.cinlan-knowledge/` |
