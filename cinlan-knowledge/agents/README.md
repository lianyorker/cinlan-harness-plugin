# agents/

`docs/hosts.md` §3 矩阵的可执行版：每个宿主一个目录，`ck` 只读这里的声明与模板，不写宿主分支。

## 宿主清单

| 目录 | 宿主 | 期 | 接入方式 |
| --- | --- | --- | --- |
| `dsh/` | DeepSeek Harness | P1 | A1：stdio + `instructions`（`full`） |
| `cinlan-harness/` | Cinlan Harness（dsh fork） | P1 | 同 dsh |
| `claude-code/` | Claude Code | P1 | A1：stdio + `SessionStart` hook；`instructions` 用 `brief` |
| `codex/` | Codex CLI | P2 | A1：stdio + `SessionStart` hook（config.toml 标记块 + `hooks.state` 信任表）；已实机验收 |
| `gemini-cli/` | Gemini CLI | P2 | A1：stdio + `SessionStart` hook（settings.json 单文件合并，timeout 毫秒 + `name` + `trust`）；`gemini mcp list` 已实跑，会话内验收待跑 |
| `hermes/` | Hermes（Nous Research） | P2 | A1：stdio + `pre_llm_call` hook（config.yaml 行级合并 + `shell-hooks-allowlist.json` 代写批准）；`hermes hooks doctor` 已实跑，会话内首轮注入待跑 |
| `opencode/` | OpenCode | P2 | A1-lite：stdio `mcp.ck`（`type:local` + argv 数组）+ `instructions`（`brief`）+ `--rules` AGENTS.md 标记块；实机验收待跑 |

## 目录约定（docs/hosts.md §6）

```
<host>/
  README.md      接入手册：手工步骤、验收、排错
  host.json      声明：配置文件位置与格式、baseline 方式、各送法预算、hook 输出形状、
                 skill 目录、可导入资产的扫描位置
  templates/     MCP 条目与 hook 条目模板
                占位符：{{CK_ENTRY}}（ck 入口绝对路径）、{{HUB_URL}}、{{AGENT}}（<team>/<name>）
```

- `host.json` 与 `packages/cli/src/hosts.ts` 的内置表同字段、同语义；声明覆盖内置表，声明缺失时用内置表。两者不一致以本目录为准，并回改内置表。
- 模板与 `ck setup` 的实际输出必须一致；差异按 bug 处理（`ck doctor` 会读出宿主配置里的 Agent 名，人工对照）。
- 宿主之间的差异若声明表达不了，先改声明字段设计，不在 `ck` 里写宿主分支。
- 目录里不放业务逻辑；A2 原生插件将来放 `<host>/plugin/`，单独立项。

## 通用接入（docs/hosts.md §4.1）

```bash
npm i -g http://<hub-host>:8424/dl/ck.tgz
ck login --hub http://<hub-host>:8424
ck setup --host <h> --agent <team>/<name>          # 只打印
ck setup --host <h> --agent <team>/<name> --write  # 落盘，已有文件先备份 .bak
ck doctor --host <h>
```

一台机器一把 key；每个宿主一个 Agent 名（如 `core/dsh-ly`、`core/cc-ly`），配装与用量按宿主区分。
写进宿主配置的命令一律是 `node <ck 入口绝对路径> …`，不依赖 PATH。
