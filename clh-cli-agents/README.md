# @cinlan/clh-cli-agents

deepseek-harness / cinlan-harness 的**外部 CLI agent 通用集成**插件：把 claude / codex / orca 这类外部 CLI agent 用一份声明式配置接入 harness——服务行提供 `ctx.clhCliAgents`（list / detect / run / state），工具行注册两个模型工具（`cli_agents_list` / `cli_agent_run`），另带一个脱离 harness 的独立 CLI（`bin/clh-cli-agents.js`）。

设计参考 [stablyai/orca](https://github.com/stablyai/orca) 的 `TUI_AGENT_CONFIG`（声明式 agent 目录 + prompt 注入语义），并结合了 harness 侧实验包（`packages/experimental/claude-code-mods`、`hooks-claude-code` + `hook-protocol`、`packages/acp`）的分析结论：harness 对外部 agent 生态已有三条接入面——进程内钩子映射、子进程 hooks 协议、JSON-RPC stdio（ACP）。本插件取第三条的**客户端方向**：不是把 harness 暴露给外部 agent（ACP server），而是把外部 agent 变成 harness 可派发的执行资源（agent 目录 + headless 运行）。`protocol: acp` 已在 schema 预留（resolveConfig 明确报未实现），后续接 orca / claude-code-acp 的 JSON-RPC stdio 协议时不用改配置结构。

## 与 harness 实验包的关系（为什么不做钩子桥）

- `claude-code-mods`：进程内跑 Claude Code mods 的 `register(on, options)`——绑定 Claude Code 的内部 API，换一个 agent 就要重写。
- `hooks-claude-code` / `hook-protocol`：spawn 子进程执行现有 hooks.json——解决的是「让 harness 触发外部脚本」，方向相反。
- `packages/acp`：把 harness agent 暴露给程序化客户端（harness 是 server）。

本插件覆盖的是第四种需求：**模型/插件想把任务派给外部 CLI agent 干活并拿回结果**。声明式目录意味着新增 claude / codex / gemini 只改配置。

## 配置参考

插件配置（cordis.yml 的 config 块，或 `--config` JSON 文件，结构相同）：

```jsonc
{
  "agents": {
    "claude": {
      "command": "claude",                          // PATH 可解析的可执行文件
      "args": ["-p", "--output-format", "json"],    // 固定参数
      "promptInjectionMode": "argv",                // argv | flag-prompt | stdin-after-start
      "argvSeparator": "--",                        // argv 模式可选：防 prompt 被当旗标
      "outputFormat": "json",                       // json 时解析 stdout 里的 JSON 值（parsed 字段）
      "timeoutMs": 600000,                          // 默认 600000（10 分钟，对齐 Claude Code hooks 惯例）
      "maxConcurrent": 2,                           // 同 agent 并发上限，默认 1
      "detect": "claude --version",                 // 缺省 <command> --version
      "cwd": "D:/work/repo",                        // 可选工作目录
      "env": { "MY_TOKEN": "${MY_TOKEN}" }          // 可选，支持 ${ENV} 插值
    },
    "codex": {
      "command": "codex",
      "args": ["exec", "--json"],
      "promptInjectionMode": "argv",
      "outputFormat": "json"
    }
  },
  "detectOnStart": true,                            // 服务启动时探测全部 agent（缺省 true）
  "log": { "level": "info", "dir": "D:/logs" }      // dir 给了就落 JSONL
}
```

三种注入模式（orca 语义）：

| 模式 | 行为 | 典型 agent |
|---|---|---|
| `argv` | prompt 作为最后一个 argv 元素（可加 `argvSeparator`） | `claude -p`、`codex exec` |
| `flag-prompt` | `promptFlag` + prompt（如 `--prefill <prompt>`） | 需要 prefill 的 TUI agent |
| `stdin-after-start` | 启动后把 prompt 写入 stdin 立即关闭 | 读 stdin 的管线式 CLI |

真实配置示例见 `config/agents.example.json`（claude + codex）；demo 配置见 `demo/config.json`。

## Windows 注意：.cmd/.bat 包装会被拒绝

Node 在 Windows 上无法用无 shell 的 spawn 直接执行 .cmd/.bat（EINVAL），而 prompt 走 shell 会有注入面，所以本插件 **spawn 不走 shell**，`command` 解析到 .cmd/.bat 时直接报 `unsupported-wrapper`。nvm 安装的 `claude`/`codex` 都是 .cmd shim——把 `command` 指到真实入口：

- Claude Code：`node_modules/@anthropic-ai/claude-code/bin/claude.exe`（本机验证过的写法，见下）
- codex：`node_modules/@openai/codex/bin/codex.js` 之类 js 入口 → `command: "node"` + args 首项

## 服务 API（ctx.clhCliAgents）

- `agentIds: string[]`
- `list(): ResolvedAgent[]`
- `detect(id, refresh?): Promise<DetectResult>` / `detectAll(refresh?)`（默认读启动缓存）
- `run(id, prompt, { cwd?, timeoutMs? }): Promise<RunResult>`
- `state(): { agents: [...], running: number }`

RunResult：`ok / exitCode / signal / timedOut / durationMs / stdout / stderr / truncated / parsed? / parseFailed? / argv / cwd / error?`（argv 含 prompt 原文，审计用）。

## 模型工具

- `cli_agents_list`：列出 agent 目录及探测状态（就绪/不在位/版本行）。
- `cli_agent_run`：派发一次性任务，返回渲染后的结果（stdout 超 4000 字符截断并标注）。

## 独立 CLI

```bash
node bin/clh-cli-agents.js --config <file> list
node bin/clh-cli-agents.js --config <file> detect [id...]
node bin/clh-cli-agents.js --config <file> run <id> <prompt...>
```

退出码：run 透传 agent 退出码（超时 124）；配置/用法错误 2。日志走 stderr，结果 JSON 走 stdout。

## e2e

```bash
npm run e2e
```

31 项断言：配置校验聚合、服务挂载与探测、三种注入、JSON 解析/parseFailed、超时、失败传播、并发排队、cwd/env、未知 agent/空 prompt、CLI 四态、工具行、dispose、真实 cordis loader 挂载（node-real）与坏配置报错（node-bad，经 demo/boot-check.mjs 挂 console exporter——cordis 默认 logger 只写内存 buffer，真实 bin.js 下坏配置对终端静默，这是运行时行为不是插件缺陷）。

## 已验证（本机实跑，2026-11-09）

- `npm run typecheck` / `npm run build`：0 错误。
- `npm run e2e`：**31/31 PASS**（真实 cordis `new Context().plugin()` 同进程 + vendor/cordis 真实 loader 跨进程）。
- **真实 agent**：本机 Claude Code `2.1.310`，经 `bin/clh-cli-agents.js` detect → `installed: true, version: "2.1.310 (Claude Code)"`；`run` 派发中文 prompt → exit 0，`parsed.result === '{"ok":true,"echo":"插件链路通"}'`（10.2s，JSON 模式）。claude 的 nvm `.cmd` shim 按 Windows 规则被拒，改用 `claude.exe` 原生入口（上面 config 写法）。
- codex：本机在位（`codex-cli 0.166.0`），但未做真实 run（同 .cmd shim 问题，需指到 js 入口，未配置验证）。
- **双运行时试装全链路**（隔离测试 profile `e2e-agents`，未碰真实 profile）：
  - dsh（官方 CLI，Desktop 0.2.2-rc.1 自带）：`plugin --profile e2e-agents allow-version @cinlan/clh-cli-agents@0.1.0 --dsh-version 0.2.2-rc.1 --accept-risk` → `add file:<包路径>` → `--dump-config` 出现 `clh-cli-agents` + `clh-cli-agents-tools` 两行 → `remove` → dump 归零。
  - clh（fork `@cinlan/cli 0.2.2-alpha.2`，注意其默认 home 是 `~/.clh`，不读 `DSH_HOME`）：`add` → dump 两行 → `remove` → dump 归零。测试 profile `C:\Users\ASUS\.clh\profiles\e2e-agents` 已重装好插件，可直接查看。
  - **发现 fork bug**：clh 的 plugin-manager 对 `file:D:/...` 形式的 spec 会原样传给 pnpm，pnpm 不认盘符开头的 file: 路径（scandir 拼成 `profile\D:\...`）报 ENOENT——改传**不带 `file:` 前缀的盘符绝对路径**（`clh plugin --profile <name> add D:/path/to/pkg`）可正常安装。官方 dsh 的 `file:D:/...` 正常。此问题已如实记录，待上游修。

## 未验证 / 已知边界

- **settings 页 / 模型工具在真实 harness 内的端到端**：本包无 client.js/settings 页；工具行经 dump-config 确认进组合、e2e 确认 `ctx.tools.register` 生效，但在真实 Desktop/fork 会话里由模型调用的链路未实测。
- **Harness 应用内 boot**：组合行已验证（dump-config），完整 fiber 启动需启动 Desktop 或 fork web，未在此跑。
- `protocol: "acp"` 仅预留（schema 放行、resolveConfig 明确报未实现）；orca / claude-code-acp 的 JSON-RPC stdio 客户端是后续工作。
- `flag-prompt` 模式只对支持 prefill 的 agent 有意义（如 orca TUI），纯 headless CLI 用 `argv` 即可。
- detect 命令走 shell（配置受信；prompt 永远不走 shell）；detect 是整条命令行字符串，路径含空格时自行加引号。
- harness 运行时版本：fork `0.2.2-alpha.2`（e2e 用的 vendor/cordis 同源）；官方 Desktop `0.2.2-rc.1` 未实测本插件（无 UI 面，风险点仅 loader 兼容，两侧行为应一致）。

## 安装

```bash
clh plugin --profile <name> add D:/path/to/clh-cli-agents   # 注意：fork 不认 file:D:/ 形式，直接传盘符绝对路径
# dsh 侧：
dsh plugin --profile <name> allow-version @cinlan/clh-cli-agents@0.1.0 --dsh-version <运行时版本> --accept-risk
dsh plugin --profile <name> add file:D:/path/to/clh-cli-agents
```

cordis.patch.yml 会向组合插入两行：`clh-cli-agents`（服务）与 `clh-cli-agents-tools`（工具，依赖 base profile 的 `tools` 服务）。
