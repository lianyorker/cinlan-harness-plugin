# cinlan-harness 接入手册

期：P1。方式：A1 —— stdio MCP + `instructions` 读档，不用 hook。与 dsh 同源（fork），差异在 home 目录与环境变量。

## 与 dsh 的差异

CLH 是与官方 DSH 并列的产品，用户根目录互相隔离：

| 项 | cinlan-harness | dsh |
| --- | --- | --- |
| 用户根目录 | `$CLH_HOME` → `$CINLAN_HARNESS_HOME` → `~/.clh` | `$DSH_HOME` → `~/.dsh` |
| `$DSH_HOME` | 明确不读 | 主变量 |
| MCP 条目落点 | `$CLH_HOME/cordis.patch.yml` 或 `$CLH_HOME/profiles/<name>/cordis.patch.yml` | 同构，换 `$DSH_HOME` |
| MCP 客户端插件 | `@deepseek-ai/dsh-mcp-client`（沿用上游包名） | 同名 |
| skill 目录 | `~/.agents/skills` | 同 |
| instructions 上限 | 32,768 字节（继承） | 同 |

出处：`cinlan-harness/packages/util/home-paths/src/index.ts`（`CLH_HOME_DIR_NAME = '.clh'`、`resolveClhHome` 的优先级、注释里的"never reads or falls back to DSH_HOME"）。

同机同时跑 dsh 和 cinlan-harness 时，两条 patch 文件互不相干；`~/.agents/skills` 是共享目录，靠 `.cinlan-knowledge.json` 标记里的 `agents[]` 引用计数区分谁在用。

## 手工接入

1. 落点：`$CLH_HOME/cordis.patch.yml`（全部 profile）或 `$CLH_HOME/profiles/<name>/cordis.patch.yml`（单个 profile）。注意 `host.json` 里声明的 `~/.clh/cordis.patch.yml` 是默认 home；若设了 `CLH_HOME`，以实际 home 为准，手工改路径。
2. 抄 [templates/mcp.patch.yml](templates/mcp.patch.yml)，替换 `{{CK_ENTRY}}`、`{{AGENT}}`。
3. 远端不装 `ck` 时用 [templates/mcp.http.patch.yml](templates/mcp.http.patch.yml)。
4. 重启或重载插件行。

等价命令（`CK_HOME` 无关；`ck setup` 按 `host.json` 写默认 home）：

```bash
ck setup --host cinlan-harness --agent <team>/<name> --write
```

## 验收

同 [dsh 的验收](../dsh/README.md#验收)，把宿主名和工具前缀里的 `dsh` 换成 `cinlan-harness`：`ck doctor --host cinlan-harness`、`mcp__ck__knowledge_status` 四项检查、团队约定问答、跨 key 权限。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `ck setup --write` 写到了 `~/.clh`，但本机设了 `CLH_HOME` | `host.json` 只声明默认 home，`ck` 不展开环境变量。手工把条目移到 `$CLH_HOME/cordis.patch.yml` |
| 同时装了 dsh，两边配装互相看见 | 预期行为：同一个 key、同一个 hub。要让两宿主 Agent 分开计，用不同 Agent 名（`<team>/clh-ly` vs `<team>/dsh-ly`） |
| 改 `~/.agents/skills` 后一个宿主删了另一个宿主的 skill | 不应该发生——删除只认本 Agent 的引用计数。真发生就查该目录的 `.cinlan-knowledge.json` 里 `agents[]` |
| 其它 | 同 [dsh 排错](../dsh/README.md#排错) |
