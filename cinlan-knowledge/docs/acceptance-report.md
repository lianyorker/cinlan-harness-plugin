# 实机验收报告（P1）

- 日期：2026-11-13（本地时间，UTC+8）。文中带 `Z` 的时间是 UTC。
- 范围：dsh、cinlan-harness、Claude Code 三个宿主；步骤按 [acceptance-manual.md](acceptance-manual.md)，判定按 [install.md](install.md) §7。
- 分工：能由进程和文件验证的部分由 Claude 做完；宿主会话内的部分（原 §2.4 待人工清单）已于 2026-11-13 上午全部实测完成。
- 本文不含任何 key，key 的存放位置见 §1。
- 文中 `<ck>` 指 `D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge\packages\cli\lib\bin.js`（本机 `ck` 不在 PATH，原因见 §5.7）。

## 0. 结论

1. 自动可验证的部分全部做完，没有失败项：hub 侧五项通过；`ck login` 落盘正确；三个宿主的 `ck mcp`、Claude Code 的 `ck hook` 对常驻 hub 的输出与文档一致；验收 skill 已物化到宿主的 skill 目录；配置写入的内容、备份、幂等、冲突处理在隔离环境里对三个宿主实测，67 项：PASS 53 / FAIL 0 / OBSERVE 14（§3）。
2. §2.4 的待人工项已于 2026-11-13 上午做完：三条 `ck setup --write` 对真实 home 写入成功，三个宿主的 `ck doctor --host <h>` 均 exit 0、八项（`config / hub / key / version / host_config / skill_dir / agent / resolve`）全 ok。
3. 会话内 C1–C4 三宿主全部实测通过（明细在 §2.4）：C1 `knowledge_status` 各宿主 delivery / agent 正确；C2 问暗号均答出 BLUE-FALCON-42；C3 会话内保存的私有记忆 probe 搜不到、按 id 取 404；C4 吊销后三个宿主的新会话都报 `UNAUTHORIZED: key revoked`、暗号答不出、会话照常收尾，随后用备用 key 恢复。dsh 与 cinlan-harness 的会话验证走 `clh --profile headless`（dsh 侧用 `CLH_HOME=C:\Users\ASUS\.dsh` 驱动同一运行时），限制与噪声见 §2.4。
4. 验收过程中修了 9 处实现缺陷，每处带测试（§4）；发现 12 处文档与实现的冲突——**至 2026-11-15 全部按 A 拍板落地**（5.9 按语义最优取 A、待 Yorker 复核），只剩 5.13 c 等实机 resume（§5；2026-11-16 实测发现本机 Google 账号的 Gemini 服务被禁，换凭据后才能跑）；另有一批观察项与设计问题（§6）。
5. [sop.md](sop.md) §C 的「实机验收」一行已勾上（§2.4 全部完成）。

| 步骤 | dsh | cinlan-harness | Claude Code |
| --- | --- | --- | --- |
| `ck login`（三个宿主共用） | 完成 | 完成 | 完成 |
| `ck setup` dry-run（真实 home） | 完成：`update` | 完成：`create` | 完成：`update` ×2 |
| `ck setup --write`（真实 home） | 完成：`update` | 完成：`create` | 完成：`update` ×2 |
| 写入内容 / 备份 / 幂等（隔离环境） | 通过 | 通过 | 通过 |
| skill 物化到宿主目录（真实 home） | 完成 | 完成 | 完成 |
| `ck mcp` 输出与文档一致 | 通过：`full` | 通过：`full` | 通过：`brief` |
| `ck hook` 输出与文档一致 | 不适用（无 hook） | 不适用（无 hook） | 通过 |
| C3 跨用户隔离（命令行层面） | 通过（共用） | 通过（共用） | 通过（共用） |
| 会话内 C1–C4 | 通过 | 通过 | 通过 |

发现项编号（F1–F14）在各节里的位置：

| 编号 | 性质 | 位置 | 编号 | 性质 | 位置 |
| --- | --- | --- | --- | --- | --- |
| F1 | 已修 | §4 | F8 | 设计问题 | §6.1 |
| F2 | 冲突待拍 | §5.4 | F9 | 已修 | §4 |
| F3 | 已修 | §4 | F10 | 已修 | §4 |
| F4 | 已修 | §4 | F11 | 观察 | §6.2 |
| F5 | 观察 | §6.3 | F12 | 冲突待拍 | §5.9 |
| F6 | 已修 | §4 | F13 | 已修 | §4 |
| F7 | 已修 | §4 | F14 | 已修 | §4 |

## 1. 环境

| 项 | 值 |
| --- | --- |
| 机器 | Windows 11 Home China 10.0.26200，Node v24.9.0，pnpm 10.33.0 |
| 版本 | ck 0.1.0，hub 0.1.0；`ck doctor` 的 `version.same = true` |
| hub | `http://127.0.0.1:50597`，`GET /healthz` → `{"ok":true}`（2026-11-13 07:50 复查仍在） |
| 进程 | 种子脚本拉起的原 hub（pid 19444）已退出；2026-11-13 上午用 `node packages/hub/lib/bin.js serve --config %TEMP%\ck-acceptance-live\hub.json` 重启了同一个库，地址不变，数据保留 |
| 数据目录 | `C:\Users\ASUS\AppData\Local\Temp\ck-acceptance-live\`：`hub.json`、`data\knowledge.db`、`hub.log` |
| key 位置 | demo 与 probe 两把 key 的明文在 `%TEMP%\ck-acceptance-live.seed.out`（种子脚本的控制台输出）；demo 的种子 key（prefix `6a6e3018`）已在 C4 中被吊销，当前 `C:\Users\ASUS\.cinlan-knowledge\key` 存的是 C4 时新铸的备用 key（`c4-backup`，prefix `55ee66be`）；SA（root）key 只在种子脚本的内存里用过，不打印；仓库里没有任何 key |
| 测试基线 | core 39 + mcp 14 + hub 26 + cli 126，fail 0（2026-11-13，最后一次代码改动之后全量重跑） |

种子数据：

| 对象 | 值 |
| --- | --- |
| 团队 | `acceptance`（`team_f59ce31bba595db6017da5db`） |
| 用户 | `demo`（Team Admin，`usr_4daa4083cab5952effaa5a04`）；`probe`（member，只用于 C3） |
| 默认模板 | `acceptance-tpl`（`agt_4ec4e7b12cc6f2517873a6b0`），绑定下面两个资产，都是 `inject` |
| 记忆 | 「验收标记-CHECKPOINT」（`ast_c59acf981961959bb507d24e` v1，团队可见，正文含暗号 BLUE-FALCON-42） |
| skill | `acceptance-checkpoint`（`ast_8b49b63a4801aa79f243a695` v1） |
| Agent | `demo-dsh` = `agt_9e9cc5e8d39b4eb96b382ca1`；`demo-clh` = `agt_f99aadde17254c0e0fd4b89a`；`demo-cc` = `agt_27001d8c35084e6c7d3c3071`（均由 `agent/ensure` 按需创建） |

两点说明：

- hub 进程起得比 F6 的重新构建早，它的远端 `/mcp`（A0）里 `knowledge_save` 的 `layer` 枚举还是修复前的，重启后才更新。stdio 的 `ck mcp` 加载的是 cli 侧的包，不受影响。hub 没有重启。
- `C:\Users\ASUS\.claude\skills` 是指向 `C:\Users\ASUS\.agents\skills` 的 Junction，所以本机三个宿主共用同一个物理 skill 目录（影响见 §6.1）。

## 2. 逐宿主结果

### 2.0 三个宿主共用的部分

hub 侧五项（install.md §7），2026-11-13 实跑：

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `GET /healthz` | `{"ok":true}` |
| 2 | `ck rpc auth/verify '{}'` | exit 0；`code 0`；user `demo`，`is_system_admin false`，teams `acceptance / admin`，`server_version 0.1.0` |
| 3 | `ck rpc team/list '{}'` | exit 0；`code 0`；含 `acceptance` |
| 4 | `ck rpc loadout/resolve '{"agent_id":"agt_9e9c…","max_bytes":24000}'` | exit 0；`code 0`；`not_modified false`；559 字符 / 845 字节；`items 2`；`skills` 为 `acceptance-checkpoint` v1；`skipped 0`；`downgraded 0`；`text` 含「验收标记-CHECKPOINT」；digest `3bae7f41…1226` |
| 5 | `ck doctor` | exit 0；`config`、`hub`、`key`、`version` 四项 ok |

`ck login`：

- 真实 home：`C:\Users\ASUS\.cinlan-knowledge\config.json`（38 字节，只有 `hub`）与 `key`（45 字节）。`ck doctor` 的 `config.sources` 是 `file / file`，说明后续命令读的是落盘文件，不是环境变量。
- 隔离环境（§3 第 1–3 项）：错 key 时 exit 1、`key rejected: UNAUTHORIZED`、什么都不写；正确时 exit 0、输出 `{ok, hub, home, verified}`；`config.json` 只有 hub，key 只在 `key` 文件里，输出不回显 key。

C3 跨用户隔离（命令行层面）：私有记忆由 `ck mcp --host dsh` 进程里的 `knowledge_save` 写入（`ast_29d8a32a077aca8e70676772`，「验收私有-20261113」，`visibility: private`）。

| 身份 | 命令 | 结果 |
| --- | --- | --- |
| probe | `ck rpc asset/search '{"query":"验收私有"}'` | exit 0；`code 0`；`hits: []` |
| probe | `ck rpc asset/get '{"asset_id":"ast_29d8…"}'` | exit 1；`404 NOT_FOUND`；`data.detail: "asset not found"` |
| demo | `ck rpc asset/search '{"query":"验收私有"}'` | exit 0；1 条命中，`visibility: private`，owner 是 demo |

这只证明了 hub 的隔离。「在宿主会话里保存，再用 probe 搜」已在 §2.4 完成（三个宿主各存一条私有记忆，probe 均搜空、按 id 取 404）。

### 2.1 dsh

| 项 | 状态 | 证据 |
| --- | --- | --- |
| dry-run（真实 home） | 完成 | `update    C:\Users\ASUS\.dsh\cordis.patch.yml` 与 `dry run: re-run with --write to apply`，exit 0。文件已存在（里面有别人的 `id: rea-mcp`），没有 ck 的块 |
| `--write`（真实 home） | 完成 | `update    C:\Users\ASUS\.dsh\cordis.patch.yml`，`wrote 1 file(s)`，生成 `.bak`；`ck doctor --host dsh` exit 0、八项全 ok |
| 写入内容 / 备份 / 幂等 | 通过（隔离） | §3 第 8–10、18–19 项：原有条目逐字节保留；追加的块就是 [hosts.md](hosts.md) §4.2 的字面量，包在起止标记里；`.bak` 等于原文件；第二次 `--write` 是 `unchanged` + `nothing to write` |
| 按写入的声明启动 | 通过（隔离） | §3 第 21–22 项：yaml 里是 `node` + ck 入口绝对路径；按它启动 → `instructions` 是完整配装，skill 物化，exit 0 |
| `ck mcp` 对常驻 hub | 通过 | initialize 335 ms；协议版本 `2025-03-26`；serverInfo `ck 0.1.0`；`instructions` 559 字符 / 845 字节，首行 `<cinlan_knowledge team="acceptance" agent="demo-dsh" digest="3bae7f41…">`，`<core>` 段有「验收标记-CHECKPOINT」与 BLUE-FALCON-42，`<skills>` 段有 `- acceptance-checkpoint`；5 个工具；exit 0，stderr 空 |
| 进程级 `knowledge_status` | 通过 | `hub {ok: true, server_version: 0.1.0}`；user `demo`；team `acceptance`；agent `demo-dsh` / host `dsh`；`baseline {delivery: full, digest: 3bae7f41…}`；`loadout {items: 2, downgraded: 0, skipped: []}`；`reviews {pending: 0}` |
| skill 物化 | 完成 | `C:\Users\ASUS\.agents\skills\acceptance-checkpoint\`：`SKILL.md`（376 字节）与标记文件 `.cinlan-knowledge.json`（`asset_id ast_8b49…`、`version 1`、`content_hash 028bbd57…`、`agents` 含三个宿主的 Agent id、`materialized_at 2026-11-12T21:50:46.938Z`） |
| `ck doctor --host dsh` | exit 0 | 八项全 ok（写入后实测） |

预算：dsh 的 `instructions` 上限 32,768 字节，host.json 预算 12,000 字符 / 24,000 字节，实际 559 字符 / 845 字节。

### 2.2 cinlan-harness

| 项 | 状态 | 证据 |
| --- | --- | --- |
| dry-run（真实 home） | 完成 | `create    C:\Users\ASUS\.clh\cordis.patch.yml` 与 `dry run: …`，exit 0。目录 `C:\Users\ASUS\.clh` 在，文件不在 |
| `--write`（真实 home） | 完成 | `create    C:\Users\ASUS\.clh\cordis.patch.yml`，`wrote 1 file(s)`；`ck doctor --host cinlan-harness` exit 0、八项全 ok |
| 写入内容 / 幂等 | 通过（隔离） | §3 第 11–12、18–19 项：新文件的内容恰好是 §4.2 的块；新文件不产生 `.bak`；重复执行 `unchanged` |
| 按写入的声明启动 | 通过（隔离） | §3 第 23 项：完整配装，exit 0；共用 skill 目录的标记文件里登记了两个 Agent |
| `ck mcp` 对常驻 hub | 通过 | initialize 323 ms；`instructions` 559 字符 / 845 字节，首行 `<cinlan_knowledge team="acceptance" agent="demo-clh" digest="ff0612f5…">`，内容同 dsh；5 个工具，`knowledge_save` 的 `layer` 枚举是 `core / profile / atom`；exit 0，stderr 空 |
| 进程级 `knowledge_status` | 通过 | agent `demo-clh` / host `cinlan-harness`；`baseline {delivery: full, digest: ff0612f5…}`；`loadout.items 2`；`reload: true` 返回的 `text`（559 字符）与 `instructions` 相同；`knowledge_search` 搜「CHECKPOINT」1 条命中 |
| skill 物化 | 完成 | 与 dsh 同一个目录（`~/.agents/skills`），标记文件的 `agents` 里有 `agt_f99a…` |
| `ck doctor --host cinlan-harness` | exit 0 | 八项全 ok（写入后实测） |

### 2.3 Claude Code

| 项 | 状态 | 证据 |
| --- | --- | --- |
| dry-run（真实 home） | 完成 | `update    C:\Users\ASUS\.claude.json` 与 `update    C:\Users\ASUS\.claude\settings.json`，exit 0 |
| `--write`（真实 home） | 完成 | 两个文件各 `update`，`wrote 2 file(s)`，生成 `.claude.json.bak` 与 `settings.json.bak`；`ck doctor --host claude-code` exit 0、八项全 ok |
| 写入内容 / 备份 / 幂等 | 通过（隔离） | §3 第 13–19 项：`mcpServers.ck` 是 hosts.md §4.3 的条目，别的键原样；`hooks.SessionStart` 追加一条（matcher 为 startup、clear、compact 三个事件），已有 hook 与 `env` 原样；两个 `.bak` 等于原文件；任何宿主文件里都没有 key |
| 按写入的声明启动 | 通过（隔离） | §3 第 24–26 项：写进去的 hook 命令经 cmd.exe 执行 → exit 0、一行 JSON、完整配装；PowerShell 下同样 exit 0；MCP 按 `~/.claude.json` 的声明启动 → brief 块 |
| `ck mcp` 对常驻 hub | 通过 | initialize 340 ms；`instructions` 306 字符 / 480 字节，是 `<cinlan_knowledge_brief team="acceptance" agent="demo-cc">` 块（上限 4,096 字符）；5 个工具；exit 0，stderr 空 |
| 进程级 `knowledge_status` | 通过 | agent `demo-cc` / host `claude-code`；`baseline {delivery: brief, digest: a634278b…}`；`loadout.items 2`；`reload: true` 返回完整配装（558 字符） |
| `ck hook` 对常驻 hub | 通过 | `ck hook session-start --host claude-code --agent acceptance/demo-cc`：exit 0，417 ms；stdout 只有一行 JSON，形状是 `hookSpecificOutput.{hookEventName: "SessionStart", additionalContext}`；`additionalContext` 558 字符（预算 8,000），首行 `<cinlan_knowledge team="acceptance" agent="demo-cc" digest="a634278b…">`，含 BLUE-FALCON-42 与 `- acceptance-checkpoint` |
| skill 物化 | 完成 | `C:\Users\ASUS\.claude\skills\acceptance-checkpoint\`（经 Junction 就是 §2.1 那个目录），标记文件的 `agents` 里有 `agt_2700…` |
| skill 热加载 | 已观察到一次 | 物化发生在 2026-11-12T21:50:46Z，本次 Claude Code 会话没有重启，skill 列表里随后出现 `acceptance-checkpoint`，调用后原样输出 `ACCEPTANCE-SKILL-OK 验收标记-CHECKPOINT`。这是 skill 目录的热加载，不能代替 C2（hook 注入） |
| `ck doctor --host claude-code` | exit 0 | 八项全 ok（写入后实测，包括吊销恢复后的复查） |

### 2.5 Codex CLI（P2 补充验收，2026-11-13 下午）

环境：codex-cli 0.166.0，`model_provider magpie` → `http://127.0.0.1:3425/v1`（`api-gpt/gpt-6-astra`）。临时验收 hub（`127.0.0.1:55853`）：team `core`、user `ly`、agent `core/codex-ly`（`agt_9fff…`），记忆「Codex 验收暗号」（暗号 `orange-lantern-42`，团队可见，`inject` 绑定）。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `ck setup --write`（真实 home） | 完成 | `update` 两行（`~/.codex/config.toml`、`~/.codex/hooks.json`），`wrote 2 file(s)`；既有 130+ 行配置与 2 个 SessionStart 组逐字节保留 |
| 写入内容 | 通过 | config.toml 尾追加标记块：`[mcp_servers.ck]`（`node` + ck 入口绝对路径 + `--host codex --agent core/codex-ly`）+ `[hooks.state.'…hooks.json:session_start:2:0']`（`enabled` + `trusted_hash`）；hooks.json 追加新组（index 2，`matcher startup\|clear\|compact`，`timeout 15`） |
| hook 信任免审 | 通过 | hooks 引擎打开后，`codex exec` 输出 `hook: SessionStart Completed`，无 `/hooks` 审查中断——预算的 `trusted_hash` 与 codex 复算一致 |
| C1 `knowledge_status` | 通过 | exec 回合输出 `mcp: ck/knowledge_status started → (completed)`——`mcp__ck__*` 工具已注册可调；回合末模型答 `null`（工具调用本身成功，答复提取细节不判失败，OBSERVE） |
| C2 暗号 | 通过 | `codex exec "团队知识库基线里记录的验收暗号是什么？"` → 模型原样答 `orange-lantern-42`，36,437 tokens 的完整模型回合 |
| `ck doctor --host codex` | exit 0 | 八项全 ok；`host_config` 从 TOML 标记块解出 `core/codex-ly`（doctor 的 TOML 解析实战生效） |

限制与噪声（不判定失败）：

- 本机 `[features] hooks` 原是 `false`：验收时改为 `true` 跑通后已还原 `false` 并从备份恢复 config.toml / hooks.json——真实 home 零残留。正式启用需 `codex features enable hooks`（或手动置 true），注意会同时激活 hooks.state 里已信任的既有 hook（ishii / orca / slo-runtime）。
- 验收回合里一条既有 SessionStart 组 `Failed`（ishii/orca 老条目，与 ck 无关）；config.toml 里 `disable_response_storage` / `preferred_auth_method` 两处未识别设置是既有噪声。
- 启用 hooks 后既有 PreToolUse / UserPromptSubmit / PostToolUse / Stop hook 均 `Completed`，未影响回合。
- 验收 hub 为临时实例（`core` 团队、单次 key），验收后已停；要长期接入按 [agents/codex/README.md](../agents/codex/README.md) 指向真实 hub 重跑 `ck setup --write`。

### 2.6 Hermes（P2 部分验收，2026-11-13 晚）

环境：`hermes.exe`（`%LOCALAPPDATA%\hermes\bin\`，Nous Research `hermes_agent` editable 安装），真实 home `C:\Users\ASUS\AppData\Local\hermes`，config.yaml 134,569 字节。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `ck setup --write` 写入 | 通过 | dry-run 预告 `update config.yaml` + `create shell-hooks-allowlist.json`；写后逐行 diff：+8 行（原文件无 `mcp_servers:`/`hooks:` 顶层键，在文件尾新建）、**0 行改动/删除**、顶层键无重复 |
| allowlist 精确批准 | 通过 | `{event: "pre_llm_call", command: "node \"…\\bin.js\" hook pre-llm-call --host hermes --agent core/hm-ly"}` 与 config.yaml 条目值逐字符一致，附 `approved_at` + `script_mtime_at_approval` |
| `ck doctor --host hermes` | 部分通过 | `host_config` ok（agent `core/hm-ly` 从嵌套 YAML 挖出）、`skill_dir` ok、`hook` ok（`hook_present + approved` 双查）；`hub`/`key`/`agent` UNAVAILABLE——本机没起 hub（`~/.cinlan-knowledge` 里存的是旧临时实例 `127.0.0.1:50597`），环境项非缺陷 |
| 首轮门控 | 通过 | `extra.is_first_turn: false` → `{}`；非 JSON stdin → `{}`；`is_first_turn: true` → `{"context": "<cinlan_knowledge error=…>"}`（hub 未起走 prepare 失败兜底，hermes-context 形状成立，exit 0） |
| 真宿主解析 | 通过 | `hermes mcp list` 列出 `ck` 条目（`node D:\Company\…`），`enabled`、`all` tools——合并产出 hermes 可读 |

还原：`config.yaml` 恢复为备份字节（sha256 一致）、`shell-hooks-allowlist.json` 与备份文件删除，零残留。

**活 hub 全链路（2026-11-13 深夜，`seed-acceptance` 临时 hub + `CK_HOME` 隔离）**：`ck setup --write` 重写后 `ck doctor --host hermes` **八项全绿**（`host_config`/`skill_dir`/`hook`+`approved`/`agent`+`resolve` digest）；`is_first_turn: true` 注入**真实 baseline**——`<core>` 里带 `验收标记-CHECKPOINT`（暗号 BLUE-FALCON-42）+ `<skills>` 带 `acceptance-checkpoint`；`hermes mcp test ck` 连上 stdio server（5,393ms，含 prepare 网络往返）发现 **5 个 `knowledge_*` 工具**；`ck skills sync` 物化 `acceptance-checkpoint` 到 `%LOCALAPPDATA%\hermes\skills`（SKILL.md + `.cinlan-knowledge.json`）。验收后 config/allowlist/skill 目录全部还原，零残留。

验收中修一处：`ck hook` 解析 stdin 前先 `trim()`——PowerShell 管道给 stdin 加 BOM 会让 `JSON.parse` 抛错，首轮永远被门成 `{}`（回归用例在 `exit.test.ts`，194 例全绿）。

**2026-11-14 走查更正**（真 Hermes v0.23.0 对临时 `HERMES_HOME` 实跑 + `agent/shell_hooks.py` 核对；真实 home 只读）：

- 上表「allowlist 精确批准 通过」不成立。当时比的是 allowlist 文件与 config.yaml 里的命令字符串，没有让 hermes 自己判定。hermes 要求根是 `{"approvals": [...]}`，而当时 `ck setup` 写出的是顶层列表，hermes 按不可读处理：`hermes hooks list` 标 `✗ not allowlisted`，`hermes hooks doctor` 报 `✗ not allowlisted — hook will NOT fire at runtime`、`1 issue(s) found.`。也就是说当时的产物在真会话里不会执行 hook；同一份文件 `ck doctor --host hermes` 却报 `approved: true`。「首轮门控」那一行是直接往 `ck hook` 的 stdin 喂载荷，不经过 hermes 的批准判定，所以没暴露。
- 已修：`setup.ts` 的 allowlist 写成 `{"approvals": [...]}`（根上其他键保留，根形状不对报 `conflict` 不覆盖），`script_mtime_at_approval` 按 hermes `script_mtime_iso` 的同串格式写；`doctor.ts` 的 `approved` 改为对 config.yaml 里每条 ck 命令按 `(event, command)` 全等匹配，顶层列表判 `false`。修后同一环境复跑：`ck setup --write` → `create`，再跑 → `unchanged`；`hermes hooks list` → `✓ allowed`；`hermes hooks doctor` → `✓ allowlisted`、`✓ script unchanged since approval`、`✓ produced valid JSON on synthetic payload`、`All shell hooks look healthy.`，exit 0。回归用例在 `setup.test.ts` / `doctor.test.ts`，cli 214 例全绿。
- 「八项全绿」：hermes 的 `ck doctor` 是九项（比其他宿主多一项 `hook`），当时 `hook` 项的 `approved: true` 属上一条的假阳性。
- 「零残留」不准确：真实 home 里还留着 `config.yaml.bak`（2026-11-13 23:43，`ck setup --write` 的备份代，与现 `config.yaml` 逐字节相同）。`config.yaml` 本身无 ck 条目、`shell-hooks-allowlist.json` 不存在，这两点成立。2026-11-14 按 Yorker 指示删掉了这份备份：删前 `cmp` 再核一次与 `config.yaml` 逐字节相同（134569 字节），删后目录里没有 `.bak`，`config.yaml` 的大小与修改时间没变；该目录下没有动别的文件。
- 仍未验证：真 hermes 会话里首轮实际收到注入（要跑模型回合）。

### 2.4 原待人工项（2026-11-13 上午全部完成）

下面保留原始步骤与判定依据；完成情况先记在这里。

**完成情况。**

A（三条 `--write`）：均按上表预期输出，dsh / Claude Code 生成 `.bak`，cinlan-harness 为新文件；随后 `ck doctor --host <h>` 三个宿主均 exit 0、八项全 ok。

B（会话内 C1–C4）：

```
宿主           C1  C2  C3  C4  备注
dsh            [x] [x] [x] [x]  CLH_HOME=~/.dsh 跑 headless 会话
cinlan-harness [x] [x] [x] [x]  clh --profile headless 一次性会话
claude-code    [x] [x] [x] [x]  claude mcp list 连接 + claude -p 会话
```

| 宿主 | 会话方式 | C1 `knowledge_status` | C2 暗号 | C3 私有记忆 |
| --- | --- | --- | --- | --- |
| dsh | `CLH_HOME=C:\Users\ASUS\.dsh` + headless profile | `agent demo-dsh` / `host dsh` / `delivery: full` / `loadout.items 2` | BLUE-FALCON-42 | 存 `ast_2e16712b7d0e160c5d52beae`（验收私有-dsh会话），probe 搜空、按 id 取 404 |
| cinlan-harness | `clh --profile headless` | `agent demo-clh` / `host cinlan-harness` / `delivery: full` / digest `ff0612f5…` | BLUE-FALCON-42 | 存 `ast_c1e2e48030e8ce4c65793db3`（验收私有-clh会话），probe 搜空、按 id 取 404 |
| Claude Code | `claude mcp list`（ck Connected）+ `claude -p` | `agent demo-cc` / `delivery: brief` / digest `a634278b…` | BLUE-FALCON-42 | 存 `ast_398e9f979b1246837dbb04a8`（验收私有-会话级），probe 搜空、按 id 取 404 |

B0（宿主能否看到 ck 这个 MCP）：dsh 侧 `CLH_HOME=.dsh` 的 `--profile web --dump-config` 显示 `~/.dsh/cordis.patch.yml` 被读入，`cinlan-knowledge` / `serverName: ck` / `--host dsh` / `--agent acceptance/demo-dsh` 条目在编入结果里；clh 侧 `--profile headless --dump-config` 同样含该条目；Claude Code 侧 `claude mcp list` 报 `ck Connected`。

C4（吊销，最后做）：先 `user-key/create` 铸备用 key（`c4-backup`），再 `user-key/revoke` 吊销种子 key（id `key_ace0c8e55edebaa9808b329c`）。三个宿主各开新会话：`knowledge_status` 均返回 `{"hub":{"ok":false,"error":"UNAUTHORIZED: key revoked"},…,host:<宿主>}`，问暗号均答「无法确定 / 不知道」，会话本身正常收尾不崩。之后用备用 key `ck login` 恢复，`doctor --host <h>` 三宿主复查仍八项全 ok。

限制与噪声（不判定失败）：

- dsh 没有独立 CLI（`where.exe dsh` 无结果），会话验证用 `CLH_HOME` 指向 `~/.dsh` 驱动同一个 `@deepseek-ai/dsh` 运行时——同一条 cordis patch → `dsh-mcp-client` → `ck mcp` 链路，加载的就是 `~/.dsh/cordis.patch.yml` 里写入的条目；桌面端 GUI 会话未启动。
- clh / dsh headless 默认模型路由 `deepseek-official` 因 DeepSeek 余额不足（`QUOTA: Insufficient Balance`）走不通，会话级验证临时把 headless profile 的 `agent-default-model` 指到 `llm-pi-ai` 的 `openai` provider（`api.cinlan.online`，key 来自 `~/.dsh/.credentials.yaml` 的 `OPENAI_API_KEY`）。验收完成后该 patch 已还原，拷入 `~/.dsh/profiles/headless` 的临时 profile 已删。
- dsh 会话期间 `~/.dsh/cordis.patch.yml` 里既有的 `rea-mcp` 条目因子进程找不到模块刷 `MODULE_NOT_FOUND` 噪音，与 ck 无关，不影响判定。
- `claude -p` 报 `claude-fable-5-2` 模型不识别的警告，属环境噪声；验收提示词仍正常完成。

**原始待人工清单（存档）。**

**A. 三条被拦下的写入命令。** 可以在本会话里用 `! <命令>` 执行，也可以在自己的终端里跑。

```powershell
node D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge\packages\cli\lib\bin.js setup --host dsh --agent acceptance/demo-dsh --write
node D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge\packages\cli\lib\bin.js setup --host cinlan-harness --agent acceptance/demo-clh --write
node D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge\packages\cli\lib\bin.js setup --host claude-code --agent acceptance/demo-cc --write
```

| 宿主 | 预期输出 | 备份 |
| --- | --- | --- |
| dsh | `update    C:\Users\ASUS\.dsh\cordis.patch.yml`，`wrote 1 file(s)` | 生成 `cordis.patch.yml.bak` |
| cinlan-harness | `create    C:\Users\ASUS\.clh\cordis.patch.yml`，`wrote 1 file(s)` | 无（新文件） |
| Claude Code | `update` 两行（`.claude.json`、`.claude\settings.json`），`wrote 2 file(s)` | 生成 `.claude.json.bak` 与 `settings.json.bak` |

写入后逐个执行 `node <ck> doctor --host <h>`，预期 exit 0、八项（`config / hub / key / version / host_config / skill_dir / agent / resolve`）全 ok。

三点提醒：

- `settings.json.bak` 是 `settings.json` 的完整副本，里面有你现有的 token。别把它带进仓库或同步盘。
- `~/.claude.json` 是 Claude Code 自己也在写的文件。Claude Code 运行期间写入后，条目会不会被它的内存状态覆盖回去——未验证：缺 Claude Code 对该文件的回写行为。写入后重跑一次不带 `--write` 的命令，应是 `unchanged`；如果又变回 `update`，关掉所有 `claude` 进程再写一次。
- 写入 Claude Code 之后，本机每个新会话都会跑 `ck hook`。验收 hub 是临时的：它停掉以后，每个新会话都会带上 stale 提示与缓存的验收配装（或错误提示块）。验收完按手册 §1.6 反向清理。

**B. 逐宿主的会话内检查。** 步骤见手册 §1–§3，这里只列要点。

| # | 检查 | dsh | cinlan-harness | Claude Code |
| --- | --- | --- | --- | --- |
| B0 | 重启宿主后能看到 `ck` 这个 MCP 与 5 个 `knowledge_*` 工具 | 确认它读的是非 profile 的 `~/.dsh/cordis.patch.yml`（§5.6） | 同左，`~/.clh/cordis.patch.yml` | `claude mcp list` 或 `/mcp` 里有 `ck` |
| C1 | `knowledge_status` | `delivery: full`，agent `demo-dsh`，`items ≥ 1` | `delivery: full`，agent `demo-clh` | `delivery: brief`，agent `demo-cc` |
| C2 | 问「验收暗号是什么？」→ BLUE-FALCON-42 | 新会话 | 新会话 | 三个触发点各一次：重启后新会话、`/clear` 之后、压缩之后 |
| C3 | 会话里 `knowledge_save` 一条「验收私有-…」，再用 probe 的 key 搜 → `hits` 为空 | | | |
| C4 | 吊销后新会话：`knowledge_status` 报 `UNAUTHORIZED`，问暗号答不出 | | | hook 输出错误提示块，会话照常打开 |
| S5 | 不重启宿主，能否发现 `acceptance-checkpoint` 这个 skill | 待确认 | 待确认 | 已观察到（§2.3） |

C3 用 probe 的 key 搜，不把 key 打到屏幕上的写法（PowerShell 7；Windows PowerShell 5.1 里 JSON 的内层双引号要写成 `\"`）：

```powershell
$env:CK_USER_KEY = ((Get-Content "$env:TEMP\ck-acceptance-live.seed.out" | Where-Object { $_ -match '^\s+probe\s+ck_' }) -split '\s+')[-1]
node D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge\packages\cli\lib\bin.js rpc asset/search '{"query":"验收私有"}'
Remove-Item Env:CK_USER_KEY
```

顺序上的建议：

- 三个宿主共用一把 demo key。C4 放到最后做一次就够：三个宿主的 C1–C3 都过了以后，按手册 §1.5 发备用 key、吊销当前 key，然后在三个宿主里各开一个新会话看失败形态，最后用备用 key `ck login` 恢复。
- 另外两个可选项：停掉 hub 后在 Claude Code 里 `/clear` 再问暗号，应能答出且上下文里有 `<cinlan_knowledge_notice stale="true" …>`（手册 §3.4）；确认 Windows 上 Claude Code 用哪个 shell 执行 hook 命令（cmd.exe 与 PowerShell 已验证，Git Bash 未验证，见 §6.9）。
- 这一轮顺带能关掉 [decisions.md](decisions.md) §6「未验证」里的三条：S2（hook 的 10,000 字符口径、`reloadSkills` 的字段位置）、S5（dsh 对 `~/.agents/skills` 的热加载）、S6（dsh Desktop 的 `insert` patch 行为与 stdio 子进程环境）。

如果 hub 没了（重启机器、误关进程）：重跑种子脚本、重新 `ck login`。在这之前先删掉 `C:\Users\ASUS\.agents\skills\acceptance-checkpoint\` 和 `C:\Users\ASUS\.cinlan-knowledge\cache\`——新库里资产 id 不同，旧目录会被判为同名冲突而不覆盖。

记录用手册 §5 的模板：

```
宿主           C1  C2  C3  C4  备注
dsh            [x] [x] [x] [x]  2026-11-13 实测通过
cinlan-harness [x] [x] [x] [x]  2026-11-13 实测通过
claude-code    [x] [x] [x] [x]  2026-11-13 实测通过
```

## 3. 隔离环境实测（配置写入与失败路径）

做法：另起一个一次性 hub；造一个假的用户目录，里面放三个宿主的配置夹具（各自带一条别人的条目）；用真实的 `ck` 二进制起子进程，把 `USERPROFILE` / `HOME` / `CK_HOME` 指到假目录。真实用户目录全程没有被写（第 37、67 项）。

- 脚本：`%TEMP%\ck-acc-isolated.mjs`；结果：`%TEMP%\ck-acc-isolated.json`
- 运行：2026-11-12T23:19:35Z → 23:20:15Z，Node v24.9.0，win32
- 结果：Total 67，PASS 53，FAIL 0，OBSERVE 14。OBSERVE 表示「记下行为，不下结论」，每一条都对应 §5 或 §6 的一项。

| 组 | 项 | 结果 | 内容 |
| --- | --- | --- | --- |
| C1 登录 | 1–3 | PASS 3 | 错 key 拒绝且不落盘；正确 key 落盘；key 不回显 |
| C2 dry-run | 4–7 | PASS 4 | 三个宿主的状态行与提示；夹具逐字节不变，无 `.bak`、无新文件 |
| C3 写入 | 8–17 | PASS 10 | 内容等于 hosts.md §4.2 / §4.3 的字面量；别人的条目不动；`.bak` 等于原文件；无 key、无临时文件残留 |
| C4 幂等 | 18–19 | PASS 2 | 第二次 `--write`：`unchanged` + `nothing to write`，文件不变，`.bak` 仍是接入前的原件 |
| C5 | 20 | OBSERVE | 刚 setup 完、还没开过会话时，`ck doctor --host dsh` exit 1，不过的是 `skill_dir`（§5.5） |
| C6 按声明启动 | 21–26 | PASS 5，OBSERVE 1 | 三个宿主都能按写进去的声明启动；第 25 项记录其他 shell：cmd.exe 通过、PowerShell 通过、Git Bash 本机常规路径下没装（§6.9） |
| C7 doctor | 27–30 | PASS 4 | 三个宿主 exit 0、每项 ok、不打印 key；Agent 能从写入的配置里读回 |
| C8 | 31 | OBSERVE | 换一个 Agent 名再跑：yaml 是 `update`（exit 0），json 是两个 `conflict`（exit 1）（§5.9） |
| C9 冲突 | 32–34 | PASS 2，OBSERVE 1 | yaml 同 id 在块外 → `conflict`、exit 1、文件不动；json 条目不同 → `conflict` 并打印 current / wanted；第 34 项：同一次执行里 `settings.json` 仍被写入（§5.8） |
| S1 dsh 读档 | 35–38 | PASS 4 | `instructions` 带记忆与 skill 行；skill v1 物化到假 home；exit 0、stderr 空、stdout 只有协议 |
| S2 / S3 | 39–41 | OBSERVE 3 | skill 升到 v2 而配装文本不变：带 `if_digest` 的解析回 `not_modified`、`skills: []`，`ck mcp` 之后磁盘上仍是 v1；对照组改了记忆 → digest 变 → 才物化到 v2（§5.4） |
| S4 | 42 | PASS | 手动 `ck skills sync` 在 digest 不变时也能拿到 v3 |
| S5 Claude Code | 43–46 | PASS 2，OBSERVE 2 | brief 块与 hook 输出正确；第 45 项：第一次 `ck mcp` 后目录不存在，`ck hook` 后仍不存在，第二次 `ck mcp` 后才有（§5.2）；第 46 项：F2 在 Claude Code 路径上同样复现 |
| T1–T4 时限 | 47–50 | PASS 4 | 见 §4 的 F10 |
| S6 吊销 | 51–57 | PASS 5，OBSERVE 2 | `ck hook` exit 0 + §3 错误块，不用缓存，缓存文件删除；`ck mcp` 的 `instructions` 是错误块，工具照常提供，`knowledge_status` 给出原因；第 56 项：`ck skills sync` exit 1，`UNAUTHORIZED: key revoked`；第 57 项：已物化的 skill 目录仍在磁盘上（§6.4） |
| S7 hub 停机 | 58–63 | PASS 4，OBSERVE 2 | `ck hook` 与 `ck mcp`（full）输出 §3 的缓存提示 + 缓存正文，逐字节一致；缓存保留；第 62 项：brief 宿主的 `ck mcp` 给的是 `UNAVAILABLE` 错误块（§6.5）；第 63 项：`ck skills sync` exit 1，`UNAVAILABLE` |
| 日志 | 64–67 | PASS 3，OBSERVE 1 | `ck.log` 里没有 key、没有资产正文；未变化的 skill 不再记成冲突；第 66 项：hub 停机时有一条 `mcp.skills_failed`（§6.6）；真实 home 未被写 |

写进宿主配置的内容（供对照）：

- yaml（dsh / cinlan-harness）：起止标记 `# >>> cinlan-knowledge (managed by ck setup; delete this block to detach)` 与 `# <<< cinlan-knowledge`；`args: ['D:\Company\…\packages\cli\lib\bin.js', 'mcp', '--host', 'dsh', '--agent', 'iso/cfg-dsh', '--baseline', 'full']`。
- json（Claude Code）：`mcpServers.ck` 的 `args` 以 `"D:\\Company\\…\\bin.js"` 开头；hook 命令是 `node "D:\…\bin.js" hook session-start --host claude-code --agent iso/cfg-cc`。
- 路径是反斜杠，与 install.md 的要求不同（§5.10）。

## 4. 验收期间的修复

都是「实现与明确契约不符」或进程崩溃，按 sop.md A.6 当期改掉。每处先写失败的测试、看它按预期的原因失败，再改代码；改完全量重跑。

**F1　`ck skills sync` 在 brief 宿主上不物化，也看不到新版本**

- 现象：Claude Code（`brief`）上第一次执行 `ck skills sync`，`written` 为空；已有缓存时，skill 升了版本但配装文本没变，同样同步不到。
- 根因：`sync` 走的是会话读档那条路——brief 不解析配装，skill 清单只取缓存；有缓存时带 `if_digest`，hub 回 `not_modified`，清单还是旧的。
- 改动：`prepare` 增加 `fresh` 选项（不带 `if_digest`、不回落缓存），`runSkillsSync` 固定用 `full` + `fresh`（`packages/cli/src/prepare.ts`、`sync.ts`）。
- 测试：`prepare.test.ts`「fresh: resolve carries no if_digest even with a cache, and the cache takes the full result」「fresh: a network failure on resolve is an error even with a cache」；`sync.test.ts`「runSkillsSync on a brief host with no cache resolves the loadout and materializes its skills」「runSkillsSync skips the digest short-circuit: a new skill version behind an unchanged text is materialized」；隔离实测第 42 项。

**F3　宿主路径里的 `~` 展开到了 ck 状态目录**

- 现象：skill 目录、宿主配置文件这些带 `~` 的路径，被展开到 ck 的状态目录下面，而不是用户目录。
- 根因：「用户 home」和「ck 状态目录」共用了一个 `home` 参数。
- 改动：分开——状态目录取 `ckHome()`，`~` 取 `os.homedir()`（`sync.ts`、`mcp.ts`、`doctor.ts`）。
- 测试：`sync.test.ts`「without a home option, ~ in skill_dir is the user home, not the ck state dir」；`mcp.test.ts`「without a home option, skills land under the user home while the cache stays in CK_HOME」；`doctor.test.ts`「without a home option, host files are looked up under the user home; result.home is the ck state dir」。

**F4　`ck doctor` 读错了团队字段**

- 现象：`key` 检查里的团队列表不对，`--host` 时「Agent 所在团队是否可见」的判断随之失真。
- 根因：没按 sdk 的 `Verification.teams[]`（`{team_id, team, role}`）读。
- 改动：改读 `teams[].team`；测试夹具的类型钉在 sdk 的 `Verification` 上（`doctor.ts`）。
- 测试：`doctor.test.ts`「healthy hub, no --host → config/hub/key/version ok」（`detail.teams` 为 `["core"]`）、「claude-code: agent parsed from mcpServers.ck args, ensure + resolve run」（`team_visible` 为 true）。

**F6　`knowledge_save` 的 `layer` 枚举与数据模型不一致**

- 现象：MCP 工具 schema 里 `layer` 是 `core / skill / atom`——`profile` 被拒，`skill` 被放行。
- 根因：枚举是手写的，没跟 sdk 的 `MemoryLayer`（`core / profile / atom`）。
- 改动：枚举改为取自 `MemoryLayer`（`packages/mcp/src/tools.ts`）。
- 测试：`packages/mcp/test/face.test.ts`「knowledge_save: layer=profile is accepted and reaches asset/create unchanged」「knowledge_save: a layer outside core | profile | atom is refused before the hub is called」。

**F7　没变化的 skill 被记成冲突**

- 现象：每次 `ck mcp` 启动，日志里都多一条 `mcp.skills_conflict`，`reason` 却是 `unchanged`（真实 home 的 `ck.log` 里还留着修复前的三条）。
- 根因：物化结果里所有「没写」的条目都被当成冲突记了。
- 改动：只记 `reason === "conflict"` 的（`mcp.ts`）。
- 测试：`mcp.test.ts`「an already materialized skill is not logged as a conflict」「a same-name directory ck did not write is logged as a conflict, without the unchanged skills」；隔离实测第 65 项。

**F9　缓存提示有两个字面量**

- 现象：`ck hook` 与 `ck mcp` 用缓存兜底时，前面那句提示的写法不一样。
- 改动：统一成 [loadout.md](loadout.md) §3 的字面量，只在 `cachedNotice()` 里定义一次（`packages/mcp/src/instructions.ts`），两处都调它。
- 测试：`hook.test.ts`「stale cache → notice prepended with fetched_at, text kept」；`mcp.test.ts`「stale cache → notice prefix, no report」；隔离实测第 58、59 项按字节比对。

**F10　3 秒时限按步各算**

- 现象：hub 慢的时候，读档最多要等两个 3 秒。
- 根因：`agent/ensure` 与 `loadout/resolve` 各带一个 3 秒超时；loadout.md §6 写的是「步骤 2–3 合计 3 秒」。
- 改动：两步共用一个截止时间（`prepare.ts`）。
- 测试：`prepare.test.ts`「the time limit covers ensure and resolve together: a slow ensure leaves resolve only the remainder」「a quick ensure leaves resolve the rest of the limit」。真实进程实测：

| 场景 | 结果 |
| --- | --- |
| T1：每步耗时 2 秒（合计 4 秒） | `ck hook` 3280 ms 返回，输出缓存提示 + 缓存 |
| T2：同一个慢 hub，`CK_TIMEOUT_MS=1000` | `ck hook` 1314 ms 返回 |
| T3：hub 接了连接不应答 | `ck hook` 3298 ms 返回，exit 0，缓存提示 + 缓存 |
| T4：同上，`ck mcp`（full） | initialize 3280 ms 应答，缓存提示 + 缓存 |

**F13　Windows 上退出码被破坏**

- 现象：`ck doctor --host`、应答较大的 `ck rpc`、失败路径上的 `ck skills sync`，输出都对，退出码却是 3221226505（0xC0000409），stderr 有 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`。
- 根因：Node v24.9.0 / win32 上，网络收发刚结束（两次以上请求，或一次几 MB 的应答）就调 `process.exit()`，会撞 libuv 的断言。与 `ck` 自己的逻辑无关。未验证：缺 libuv 层面的确切机理，以及其他 Node 版本上的表现。
- 改动：这三个出口改成设 `process.exitCode`、让事件循环自然排空（`packages/cli/src/bin.ts` 的 `cmdRpc`、`cmdSkills` 的失败路径、`cmdDoctor`）。`cmdHook`、`cmdMcp` 此前已是这个做法。
- 测试：`exit.test.ts` 起真实进程——「ck doctor --host: every check ok → exits 0, nothing on stderr」「ck doctor --host: a failing check → exits 1」「ck skills sync: a failure after the hub was reached → error JSON on stdout, exits 1」「ck rpc: a multi-megabyte response → the whole envelope on stdout, exits 0」「ck rpc: an error envelope → printed as is, exits 1」。修复前其中 4 个失败在 `code: 3221226505` 上；另用探针脚本连跑 120 次，异常退出 0 次。
- 其余还在调 `process.exit()` 的出口见 §6.8。

**F14　`ck hook` 的兜底分支不是 §3 的错误提示块**

- 现象：`ck hook session-start --host <不认识的宿主>`（或 `--agent` 写错）输出的是一句 `团队记忆中枢本次读档失败：INTERNAL。`，没有 `<cinlan_knowledge error="…">` 外壳，也没有「调用 knowledge_status 查看原因」。loadout.md §4 第 5 条写的是「读档失败时输出 §3 的错误提示块」。
- 根因：`bin.ts` 的 `cmdHook` 在 `runHook` 之外还有一个 catch，自己拼了一句。
- 改动：改调 `errorInstructions()`，与 `runHook` 同一个形状。
- 测试：`exit.test.ts`「ck hook: a host ck does not know → exits 0, stdout is the loadout.md §3 error block」（真实进程；修复前失败在字面量上）。

## 5. 文档与实现的冲突（待拍）

这些都没有擅自处理：权威文档没改，对应的代码也没改。每项给出两边的说法、证据、选项和我的建议。标了「已拍」的条目已按拍板处理，落地与验证写在各节末尾。

| # | 主题 | 建议 |
| --- | --- | --- |
| 5.1 | dry-run 不打印将写入的内容 | 改实现：只打印 ck 管的那一段。**已拍 A，2026-11-15 落地** |
| 5.2 | 自动物化只发生在 `ck mcp` | 改实现：`ck hook` 也物化。**已拍 A，2026-11-15 落地** |
| 5.3 | `knowledge_status` 缺 `stale` 等字段 | 改实现：补齐。**已拍 A，2026-11-15 落地** |
| 5.4 | skill 升版本而配装文本不变时，宿主自动拿不到（F2） | hub 在 `not_modified` 时也返回 `skills[]`。**已拍 A，2026-11-15 落地** |
| 5.5 | `ck doctor` 的检查项少于文档 | 改实现；至少先改 `skill_dir` 的判据。**已拍 A，2026-11-14 落地** |
| 5.6 | dsh / clh 的配置落点 | 保持实现，hosts.md 补一句。**已拍 A，2026-11-14 落地** |
| 5.7 | `/dl/ck.tgz` 没有产出 | 补打包步骤，随后验 S4。**已拍 A，2026-11-15 落地（S4 冒烟级）** |
| 5.8 | 冲突时部分写入 | 改实现：一次执行要么全写要么不写。**已拍 A，2026-11-14 落地** |
| 5.9 | 换 Agent 名重跑，yaml 与 json 行为不同（F12） | 需要你定口径。**已按语义最优取 A，2026-11-15 落地（待 Yorker 复核）** |
| 5.10 | 写进配置的路径是反斜杠 | 改实现：统一正斜杠。**已拍 A，2026-11-15 落地** |
| 5.11 | `generic` 宿主不打印手工片段 | 与 5.1 一起做。**已拍 A，2026-11-15 落地** |
| 5.12 | sop.md 看板上的测试计数 | 换成实测值。**已换，2026-11-14 落地** |
| 5.13 | P2 宿主适配走查（codex / gemini-cli / hermes / opencode）的待拍项 | 逐条见该节；a、b、d、e 已拍并落地，c 等实机 resume |

### 5.1 dry-run 不打印将写入的内容

- 文档：install.md §5「接一个宿主（默认 dry-run，打印将写入的内容）」；hosts.md §4.1「只打印将要写入的内容」。
- 实现：只打印 `<状态> <路径>` 和一句 `dry run: re-run with --write to apply`；只有 `conflict` 才带 current / wanted。
- 证据：§2.1–§2.3 的 dry-run 输出；§3 第 4–6 项。
- 选项：A 改实现，打印 ck 管的那一段（yaml 的标记块、json 的 `mcpServers.ck` 与 hook 条目），带测试。不打印整个文件——`settings.json` 里有 token。B 改文档的说法。
- 建议：A。
- **已拍 A（2026-11-15）并落地**（decisions O-34）：`FileChange` 加 `preview` 字段，各 planner 填 ck 管的那段（yaml / toml 标记块、json 的 mcp / hook 条目与 allowlist 条目、hermes 的两段行、markdown 规则块）；`ck setup` dry-run 逐文件缩进打印，unchanged / conflict 不打（conflict 已有 current / wanted）。验证：`exit.test.ts` 真进程两例先红后绿——dry-run 打印 `mcpServers.ck:` 与 `hooks.SessionStart: [ …,`，既有文件里别人的键（`numStartups`）不被回显、不落盘。连带 §5.11 见下。文档同步：install.md §5。

### 5.2 自动物化只发生在 `ck mcp`

- 文档：loadout.md §6 的 `prepare` 第 5 步「物化 skills[] 差量写入宿主的 skill 目录」；hosts.md §5「`ck skills sync`：手动物化 skill（平时由 `mcp` / `hook` 启动时顺带做）」；hosts.md §4.3「hook 在有变更时返回 `reloadSkills: true`」。
- 实现：只有 `ck mcp` 在后台物化。`ck hook` 不物化，也不输出 `reloadSkills`。
- 后果（§3 第 45 项）：Claude Code 上第一次 `ck mcp` 拿不到 skill 清单（brief 不解析配装），hook 跑完也不物化，要等到第二次 `ck mcp`——即第二个会话——才落盘。`generic` 这类没有 hook 的 brief 宿主永远不会自动物化。
- 选项：A `ck hook` 也物化（时限按 loadout.md §6 另计 10 秒），`reloadSkills` 等 S2 确认字段位置后再加。B brief 的 `ck mcp` 为物化单独解析一次。C 文档改成现状。
- 建议：A。
- **已拍 A（2026-11-15）并落地**（decisions O-35）：`runHook` 带出 `prepared`，`cmdHook` 在输出协议 JSON 后调 `syncSkills`（10 秒上限，失败记 `hook.skills_conflict` / `hook.skills_failed`，exit 0 不变；hermes 非 first-turn 的早退分支不物化——first turn 会做）。消掉了「brief 宿主第一个会话拿不到 skill」与「无 hook 宿主永不物化」。`reloadSkills` 仍不写（S2 未确认）。验证：`exit.test.ts` 真进程一例先红后绿（带 skill 的 hub → `ck hook` → stdout 只有协议 JSON、`~/.claude/skills/audit/` 已落盘、exit 0）。文档同步：loadout.md §6（「两者都会物化」）、hosts.md §5。

### 5.3 `knowledge_status` 缺字段

- 文档：loadout.md §5 说它返回 `baseline`（`delivery, digest, current_digest, changed, stale`）和 skill 物化结果与冲突；loadout.md §4 第 2 条「`knowledge_status` 会报 `baseline.changed = true`」；install.md §7 的宿主侧第 1 项要看 `stale: false`；install.md §8 的排错表有一行 `stale: true`。
- 实现：只返回 `baseline.{delivery, digest}`。`StatusResult` 类型里声明了 `current_digest / changed / stale` 和 `skills {materialized, conflicts}`，没有任何地方填。
- 证据：§2.1–§2.3 的进程级 `knowledge_status` 输出。验收手册已经按现状写（§1.2 的注意事项）。
- 选项：A 补齐字段，带测试。B 文档收窄。
- 建议：A。install.md §7 的验收判据直接依赖 `stale`。
- **已拍 A（2026-11-15）并落地**（decisions O-36）：
  - `McpContext` 加可选 `session`（`digest` / `stale` / `skills` 快照）与 `baseline_budgets`；`ck mcp` 注入：digest 取投递文本的 digest（brief 不解析 → null）、`skills` 快照由后台物化回填（空清单也落成 `{materialized: 0, conflicts: []}`，物化失败保持 null → 键不出现）。
  - statusTool 填 `baseline.{digest, current_digest, changed, stale}` 与 `skills`；`current_digest` 用与 session 同一份预算解析（`baseline_budgets` 取 `instructions` ?? `hook`），`changed` 才是同口径比较。
  - A0（hub `/mcp`）无 session：`baseline` 只有 `delivery + digest`，`changed` / `stale` / `skills` 键不出现——loadout.md §5 末条「A0 无本机状态则不出现」的既有约定按此落地。
  - 验证：mcp 包 `face.test.ts` +2 例（带 session 的四字段 + skills 快照；A0 只有 delivery + digest、无 skills 键）；`t10.test.ts` 双面用例改为共有子集逐字段比，另断言 ck 侧 `digest === current_digest`、`changed: false`、`stale: false`、`skills: {materialized: 0, conflicts: []}` 与 brief 侧 `digest: null`；cli `mcp.test.ts` +2 例（快照回填、stale 缓存路径）。cli 223 → 230 绿。
  - install.md §7 的 `stale: false` 判据现在真的可查。

### 5.4 skill 升了版本而配装文本不变时，宿主自动拿不到（F2）

- 文档：loadout.md §7 的物化语义是按 `skills[]` 的版本差量写入。
- 实现：配装文本里 skill 只占一行名字，升版本不改变 digest。客户端带 `if_digest` 解析，hub 回 `not_modified` 且 `skills: []`，客户端沿用缓存里的旧清单。
- 证据：§3 第 39–41、46 项（磁盘上停在旧版本；改一条记忆让 digest 变了以后才更新）。手动 `ck skills sync` 不受影响（F1 之后，第 42 项）。
- 选项：A hub 在 `not_modified` 时也返回 `skills[]`（和 `items`）。这是对 `/api/v1` 的加法，要同步 [api.md](api.md) 与 sdk fixture。B digest 把 skill 清单也算进去（改 loadout.md §2 第 8 步的定义）。C skill 行里带版本号（改 loadout.md §3 的文本格式）。
- 建议：A。
- **已拍 A（2026-11-15）并落地**（decisions O-37）：hub 的 `resolveLoadout` 在 `not_modified` 时返回真实的 `items / skills / skipped / downgraded`（`text` / `chars` / `bytes` 为空表无需重投）——这几项在短路判定前就已算好，只是原来被硬置空。客户端 `prepare` 在 not_modified 时清单取本次应答，与缓存不同则原子刷新缓存（网络兜底不再退回旧版本）。api.md §4、loadout.md §6 已同步；sdk fixture 本就是全量示例不用改。验证：core `loadout.test.ts` 补主场景（skill 升版本、摘要行不变 → `not_modified: true` 且 `skills[0].version = 2`、content_hash 变化）与短路段清单断言；cli `prepare.test.ts` +1 例（清单刷新 + 缓存重写 + 文本沿用）。§3 第 39–41 项记的旧行为（磁盘停在 v1）随之消除；F1 的 `fresh` 机制（`ck skills sync` 显式路径）保留。

### 5.5 `ck doctor` 的检查项少于文档

- 文档：install.md §5 末尾「`ck doctor` 逐项检查：ck 版本与 `server_version`、hub 连通、key 有效、agent 归属、config 条目存在且指向本机 ck、hook 条目存在、skill 目录可写、缓存状态」。
- 实现：不带 `--host` 是四项（`config / hub / key / version`）；带 `--host` 再加 `host_config`（条目在不在、Agent 是谁）、`skill_dir`（只看目录存在）、`agent`、`resolve`。没有「指向本机 ck」「hook 条目」「skill 目录可写」「缓存状态」。
- 后果：新机器刚 `ck setup --write` 完，`ck doctor --host` 是 exit 1——skill 目录要到第一次物化才建（§3 第 20 项）。
- 选项：A 补齐四项，`skill_dir` 的判据改成「存在且可写，或父目录可创建」。B 文档收窄到现状。
- 建议：A；如果要分步，先改 `skill_dir` 的判据。
- **已拍 A（2026-11-14）并落地**（decisions.md O-32）：
  - 「指向本机 ck」：`host_config.detail.points_to_self`——stdio 条目的 argv（JSON 读条目、yaml insert / toml 在标记块里找 `args: [...]`、hermes 嵌套条目同）里找 ck 自己的入口路径（分隔符与大小写归一后比）；http 条目为 `null`（n/a）；argv 可解析但不含本机 ck 时 `host_config` 不过。`DoctorOptions` 加 `ckEntry` 供测试注入，缺省取当前模块旁的 `bin.js`。
  - 「hook 条目存在」：json 宿主（claude-code / gemini-cli / codex）与 yaml 宿主（hermes，原有逻辑不动）统一查 `hook` 项（`hook_file` + `hook_present`）；codex 声明了 `hook.trust` 的再复算 `[hooks.state.*]`：`trust_entry_present`（`<hooks.json 绝对路径>:<事件>:<组>:<项>` 的状态键在）、`trust_enabled`、`trusted_hash_matches`（按 `commandHookHash` 对 hooks.json 里当前条目复算），三者全真 hook 才 ok。这也是 §5.13 e 的落地。
  - 「skill 目录可写」：判据改「存在且可写，或最近的已存在祖目录可写」——写临时文件探测后删除。消掉了「刚 setup 完、还没开过会话时 `ck doctor --host dsh` exit 1」的观察项（§3 第 20 项）。
  - 「缓存状态」：新增 `checks.cache`，报 `path`（`<ck 状态目录>/cache`）与 `entries`（目录缺失为 null）；通报项，不计成败。
  - 检查项计数随宿主变化：dsh / cinlan-harness 九项，claude-code / codex / gemini-cli 十项，hermes 十项（原有 hook 项）；不含 `--host` 时是五项（原四项 + cache）。
  - 验证：`doctor.test.ts` 重写——claude-code / codex / gemini 用例改为真 `planSetup` 落盘后跑 doctor（此前是手摆夹具）；新增 points_to_self false、hook 条目缺失、祖目录是文件、cache 通报四例与 codex 信任复算正反两例（改 hooks.json 里的命令 → hash 对不上）；`exit.test.ts` 两例 doctor 用例同步（检查清单 +9 cache，失败例改用「`~/.agents` 落成文件」触发 skill_dir 红）。均先红后绿，cli 223 例全绿；`pnpm -r test` 全绿（panel 41、core 52、mcp 14、hub 51、cli 223）。
  - 真 `ck` 进程对临时 home 六场景复核（codex fresh / codex 篡改 hooks.json / claude-code fresh / claude-code 拆 hook / dsh fresh / dsh 的 `~/.agents` 落成文件）：新检查项全部按上述口径亮红亮绿；fresh 场景 `skill_dir.exists = false` 但 ok（父目录可创建）。
  - 未验证：真 codex / gemini-cli / hermes 实机上的 doctor 全绿复跑（沿用 §5.13 的走查方式，下一轮实机验收一起做）。文档同步：install.md §5、hosts.md §5、decisions.md O-32。

### 5.6 dsh / cinlan-harness 的配置落点

- 文档：hosts.md §4.2 写的是 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）；cinlan-harness 的 home 按 `CLH_HOME` → `CINLAN_HARNESS_HOME` → `~/.clh` 解析。
- 实现：`ck setup` 只写 `~/.dsh/cordis.patch.yml` 与 `~/.clh/cordis.patch.yml`，不展开环境变量，不处理 profile。`agents/dsh`、`agents/cinlan-harness` 的 README 写了「设了变量或用 profile 的，手工挪过去」。
- 证据：本机这几个变量都没设，落点与默认一致。宿主是否读取这个非 profile 的文件，要在 §2.4 B0 里确认。
- 选项：A 保持实现，hosts.md §4.2 补一句「`ck setup` 只写默认位置」。B `ck setup` 支持 `$VAR` 与 `--profile`。
- 建议：A。验收手册 §2.1 里我自己写错的一句已经改正（原文说「设过环境变量，文件在变量指向的目录下」，与实现不符）。
- **已拍 A（2026-11-14）并落地**（decisions.md O-33）：保持实现。hosts.md §4.2 补「`ck setup` 只写默认位置 `~/.dsh/cordis.patch.yml`：不展开 `$DSH_HOME`、不处理 profile；设了变量或用 profile 的，dry-run 看过生成的块后手工挪到目标文件（cinlan-harness 的 `~/.clh/cordis.patch.yml` 同此）」。§5.13 d 随此拍板关闭（三个 README 的「只读写默认位置」说明即现状）。

### 5.7 `/dl/ck.tgz` 没有产出

- 文档：install.md §5 与 hosts.md §4.1 的安装方式是 `npm i -g http://<hub-host>:8424/dl/ck.tgz`；decisions.md 的 D-19 写「自包含 tarball，由 hub 的 `/dl` 分发」；sop.md 的 S4 是「在干净机器上安装」。
- 实现：仓库里没有产出这个 tarball 的构建步骤。常驻 hub 上 `GET /dl/ck.tgz` 返回 404。
- 后果：本次验收里写进宿主配置的 ck 路径是仓库里的 `packages\cli\lib\bin.js`，不是全局安装的 `ck`；S4 无从验证。
- 选项：A 补打包步骤（Docker 多阶段构建也要用它），然后验 S4。B 延后，在 install.md 里标明「目前从仓库运行」。
- 建议：A。P2 的验收门（Codex / Gemini 各过 install.md §7）同样要用到它。
- **已拍 A（2026-11-15）并落地**（decisions O-40）：`scripts/pack-ck.mjs`（`pnpm pack:ck`）产出 `dist/ck.tgz`——cli `lib/` + `agents/` 进 stage，workspace 依赖（sdk / mcp）手工拷进 `node_modules`，registry 依赖（zod、`@modelcontextprotocol/server` 及传递）由 `npm install` 解析，全部登记 `bundledDependencies` 打进 tarball（约 3MB，大头是 MCP SDK 本体）。hub 的 `/dl` 本就有实现（`<dataDir>/dl/<file>`、路径穿越 404），出线把 ck.tgz 拷进 `<dataDir>/dl/` 即生效。途中排掉两个 npm 陷阱并写进脚本注释：tarball 内嵌套 `file:` 依赖 npm 不支持；npm pack 会丢弃 `dependencies` 未声明的 `node_modules` 包（extraneous）。验证：S4 冒烟——临时目录 `npm i <ck.tgz>` → `ck --version`、claude-code dry-run（agents 在包内、preview 打印、路径正斜杠）、generic 片段全部通过，tarball 内容抽查（sdk / mcp / agents / bin）齐全；`/dl` 分发实测（200、字节与 sha256 逐一致、`/dl/../hub.json` 404）。未做：干净 Windows / Linux 机器上的完整 S4（需要真机）；install.md §4 的 Docker 多阶段构建把 `pnpm pack:ck` 接进去仍待接线。文档同步：install.md §2、api.md 无涉。

### 5.8 冲突时部分写入

- 文档：hosts.md §5「目标条目已存在且内容不同 → 不覆盖，打印差异并退出」；install.md §5「同名条目内容不同 → 拒绝并打印两份内容，要求人工确认」。
- 实现：按文件各自处理。`ck setup --host claude-code --write` 遇到 `~/.claude.json` 里的 `mcpServers.ck` 冲突时，拒绝了这个文件，却仍把 hook 条目写进 `settings.json`，输出 `wrote 1 file(s)`，exit 1。
- 证据：§3 第 34 项。
- 后果：宿主处在半接入状态——hook 在跑，MCP 条目是别人的。
- 选项：A 一次执行只要有 `conflict` 就什么都不写。B 文档写明「按文件处理」。
- 建议：A。
- **已拍 A（2026-11-14）并落地**：`applyPlan` 在任一变更是 `conflict` 时一个文件都不写、不留 `.bak`；`ck setup` 末行改为 `nothing written: resolve the conflict(s) above, then re-run`，exit 1。验证：`setup.test.ts` 加 claude-code（mcp 冲突时 hook 不落盘）、codex（换 `--agent` 两个文件字节不变、无 `.bak`）两例，hermes 批准表冲突用例补断言 `config.yaml` 不生成；`exit.test.ts` 加真进程一例（逐行比 stdout 与退出码）；四例先红后绿。真 `ck` 进程对临时 home 复跑 codex 换 Agent：两个文件 sha1 前后一致、exit 1；手工清掉 `hooks.json` 里旧的 ck 条目后重跑 → 两个文件都 `update`、信任表在、exit 0。文档同步：hosts.md §5、install.md §5、`agents/{claude-code,codex,hermes}/README.md`、decisions.md O-31。§3 第 34 项记的是改之前的行为。

### 5.9 换一个 Agent 名重跑时，yaml 与 json 行为不同（F12）

- 文档：hosts.md §5「对 TOML / YAML 追加一段带起止标记的块，重复执行不重复写。目标条目已存在且内容不同 → 不覆盖，打印差异并退出」。
- 实现：yaml 的标记块归 ck 所有，内容不同就原地替换（`update`，exit 0）；json 的 `mcpServers.ck` 与 hook 条目内容不同就是 `conflict`（exit 1）。`setup.ts` 的文件头注释写的是「块归 `ck` 所有，重复执行原地更新、不重复追加」。
- 证据：§3 第 31 项。decisions.md 里没有对应条目。
- 选项：A 两种格式都原地更新（条目名 `ck` 归 ck 所有）。B 两种格式都拒绝，要求先手工删掉。C 保持现状并写进文档。
- 建议：没有倾向性证据，需要你定。A 对「换 Agent 名」这个常见操作最顺手；B 最保守。
- **按语义最优取 A（2026-11-15）并落地，待 Yorker 复核**（decisions O-38）：理由——`setup.ts` 的文件头注释本来就写着「块归 `ck` 所有，重复执行原地更新」，yaml / toml 已是这个语义；json 条目名 `ck` 同样是 ck 的保留命名空间，与「半接入」无关（半接入只在条目是别人的时发生，而那仍报 conflict）。`mergeMcpJson` / `mergeHookJson` 改为原地更新：`mcpServers.ck` 内容不同 → 覆写；同 matcher 组里已有我们的 session-start 条目且内容不同 → 原位替换。换 `--agent` 重跑对所有宿主都是 update、exit 0；codex 的 `[hooks.state.*]` 信任表随 hooks.json 新命令重算（下标从合并后的文档重新定位）。剩余冲突只有结构性问题（文件不是合法 JSON、`hooks.<event>` 不是列表、allowlist 根形状不对、yaml / toml 块外同名 id / 表），5.8 的「有冲突整次不写」对它们照旧生效。验证：`setup.test.ts` 的 claude-code / gemini / opencode「同名不同内容」用例改为断言原地更新（含 `.bak` 留接管前内容），5.8 的两处冲突用例改由坏 JSON 触发（claude-code、codex 各一）；codex 新增「换 Agent 两文件都 update、信任表跟着换」正反两例；真进程 `exit.test.ts` 同步。§5.13 b 随之关闭（换 Agent 不再是冲突路径）。文档同步：hosts.md §5、install.md §5、`agents/codex/README.md`（原「先删旧条目再跑」的说法已改）。

### 5.10 写进配置的路径是反斜杠

- 文档：install.md §5「路径一律写正斜杠、绝对路径；Windows 上同样适用」。
- 实现：ck 入口取自 `fileURLToPath(import.meta.url)`，Windows 上是反斜杠，原样写进 yaml 与 json。
- 证据：§3 末尾的写入内容。按这个写法，cmd.exe 与 PowerShell 下都能启动（第 24–25 项）；Git Bash 未验证。
- 选项：A 写入前统一成正斜杠，同步改 golden 测试。B 文档改成「原样写本机路径」。
- 建议：A。
- **已拍 A（2026-11-15）并落地**（decisions O-39）：`ckEntry()` 统一正斜杠，Windows 写 `D:/…`（cmd / PowerShell / Git Bash 的双引号里都原样保留，§6.9 的不确定随之消掉），POSIX 无变化；doctor 的 `points_to_self` 比较本就做了分隔符与大小写归一。golden 测试的 ckEntry 是测试注入的字面量，不涉及。验证：S4 冒烟里装出的 ck 写宿主配置已是正斜杠；全量测试无回归。

### 5.11 `generic` 宿主不打印手工片段

- 文档：install.md §5「其他宿主：`ck setup --host generic-mcp` 打印手工配置片段；或直接用 A0」。
- 实现：`--host generic-mcp` → `ck setup: unknown host "generic-mcp"; known: claude-code, dsh, cinlan-harness, generic`，exit 1。`--host generic` → `ck setup: host generic declarations host no MCP config file`，exit 1，没有打印任何片段（这句报错本身还有笔误，§6.10）。
- 证据：2026-11-13 在真实 home 上跑的两条只读命令。
- 选项：A `--host generic` 打印片段并 exit 0，宿主名以哪个为准由你定（文档写 `generic-mcp`，声明目录叫 `generic`）。B 文档删掉这一句。
- 建议：A，和 5.1 一起做——两者都是「把将要写的内容打印出来」。
- **已拍 A（2026-11-15）并落地**（随 5.1，decisions O-34）：宿主名取声明目录的 `generic`，`generic-mcp` 在 `hostConfig` 里作为别名归一（`knownHosts` 列表不变）。`cmdSetup` 对「声明无配置文件且无 hook」的宿主打印 stdio + http 两份手工片段（实际 ckEntry 与 hub 地址代入，stdio 条目 key 不进宿主配置、http 条目的 Authorization 用 `$CK_USER_KEY` 占位），exit 0；`--write` 与否同样行为（没有可写的东西）。planSetup 的报错笔误（§6.10「declarations host」）已改成 `declares no MCP config file; use \`ck setup --host generic\` to print a manual snippet`。验证：`exit.test.ts` 真进程一例（generic 与 generic-mcp 双别名、片段内容与退出码）先红后绿。文档同步：install.md §5。

### 5.12 sop.md 看板上的测试计数

- 文档：sop.md §C 的 T1–T13 一行写着「core 39 + mcp 12 + hub 26 + cli 187 + agents 8 全绿」。
- 实测：core 39 + mcp 14 + hub 26 + cli 126，fail 0；没有单独的 agents 测试套件（`packages/cli/test/agents.test.ts` 在 cli 里）。
- 说明：mcp 多出的 2 个是 F6 的测试。cli 在本会话里的计数是 103 → … → 126，从未到过 187；这个数的来历没能查出来。
- 建议：把这一行换成实测值。我没有动它。
- **已落地（2026-11-14）**：sop.md 那行换成当时的实测值（core 52 + mcp 14 + hub 51 + cli 223，fail 0，panel 41），并注明「agents 无独立套件、各条目里的历史计数不回改」。

### 5.13 P2 宿主适配走查的待拍项（2026-11-14）

走查方式：真 `ck` 进程对临时 home 跑 `setup` / `doctor`，再用真宿主的只读命令读回（codex 0.166.0、Hermes v0.23.0、npx 缓存里的 gemini-cli 0.68.0，各自的 home 都指到临时目录）。opencode 本机未装，只对照了 ck 自己的声明与模板。下面几条的代码和权威文档都没有动。

| # | 主题 | 两边的说法与证据 | 选项 | 建议 |
| --- | --- | --- | --- | --- |
| a | codex 远端条目的密钥变量名 | `agents/codex/templates/mcp.http.toml` 与 `setup.ts` 写的是 `bearer_token_env_var = "CK_KEY"`；ck 自己读的、以及 hosts.md §5、install.md §2、loadout.md §6、blueprint.md 写的都是 `CK_USER_KEY`。真 codex `mcp get ck` 读回 `bearer_token_env_var: CK_KEY` | A 改成 `CK_USER_KEY`（模板、`setup.ts`、golden 用例，panel `hosts.json` 重新生成）；B 保持，文档写明 codex 另用一个变量 | A |
| b | codex 换 `--agent` 重跑 | `config.toml` 的标记块原地替换成新 Agent（`update`），`hooks.json` 里的旧条目报 `conflict` 不动；hook 冲突时标记块里的 `[hooks.state.*]` 信任表也一并没了。结果是 MCP 指向新 Agent、hook 还在注入旧 Agent 的配装，且 hook 回到未信任 | 5.8 与 5.9 的 codex 版本，随那两条的口径 | 5.8 取 A（有 `conflict` 就整次不写）可以消掉这一条 |
| c | gemini-cli 的 hook matcher 含 `resume` | decisions.md O-30 的理由是「兜住清空/恢复后无 baseline」；claude-code 与 codex 以「恢复的历史里已经有 baseline」为由排除 `resume`。gemini 交互式注入走 `addHistory`，恢复的会话里是否还留着上次那份 `<hook_context>` 没有验证 | A 保持（最坏多注入一份）；B 去掉 `resume`（最坏恢复后没有 baseline） | 先实机 resume 一次再定，之前保持 A |
| d | 宿主 home 的环境变量 | codex 认 `CODEX_HOME`、hermes 认 `HERMES_HOME`、gemini-cli 认 `GEMINI_CLI_HOME`（三者实跑确认）；`ck setup` / `ck doctor` 只读写默认位置。`agents/hermes/README.md` 写了「`HERMES_HOME` 可覆盖」，没说 ck 不跟 | 与 5.6 是同一个问题 | 跟 5.6 的结论；取 A 时三个 README 各补一句 |
| e | `ck doctor` 的 hook 检查 | hermes 查 hook 条目与批准（共九项）；codex / gemini-cli 不查 hook 条目，也不查 codex 的信任表。各处文档写的是「八项全 ok」 | 与 5.5 是同一个问题 | 5.5 取 A 时把 json / toml 宿主的 hook 条目一起补上 |

拍板与落地（2026-11-14，Yorker：按建议拍）：

- a：取 A，已落地。模板、`setup.ts`、golden 用例改成 `CK_USER_KEY`（golden 先红，模板一致性用例随后红，再绿）；`packages/panel/public/hosts.json` 随 build 重新生成。真 `ck` 进程对临时 home 写 http 条目，真 codex 0.166.0 对临时 `CODEX_HOME` 跑 `codex mcp get ck` 读回 `bearer_token_env_var: CK_USER_KEY`。
- b：随 5.8 取 A，已落地，见 §5.8 末尾。**2026-11-15 更新：5.9 已按 A 落地（decisions O-38），换 `--agent` 重跑不再是冲突——两个文件都原地更新、信任表跟着换，本条彻底关闭**（口径差异的根源已消除，`agents/codex/README.md` 的「先删旧条目」说法已改）。
- c：保持现状（matcher 含 `resume`）。实机 resume 需要装 gemini-cli 并跑模型回合，还没做，做完再定。**2026-11-16 实测尝试（`%TEMP%\ck-gemini-resume.mjs`，走查同款临时 hub + 临时 GEMINI_CLI_HOME）**：`ck setup --write` 与 doctor 十项在临时 home 全绿、OAuth 凭据（`oauth_creds.json` 等）已拷入临时 home，但模型回合被账号侧硬拒——`Error authenticating: This service has been disabled in this account for violation of Terms of Service`（LY 当前 Google 账号的 Gemini 服务被禁）。阻塞原因从「等实机」变为「等可用凭据」：换账号 OAuth 或设 `GEMINI_API_KEY` 后重跑该脚本即可裁决（会话 1 问数学、`-r latest` 会话 2 问暗号的设计已备好）。判定仍保持 A。
- d：建议是「跟 5.6 的结论」。**5.6 已按 A 拍（2026-11-14）**：本条随之关闭——`ck setup` / `ck doctor` 只读写默认位置是正式口径，不实现 `$VAR` 展开。上一轮已补的 `agents/{codex,gemini-cli,hermes}/README.md` 三句说明即现状；hosts.md §4.2 已补句（见 §5.6 末尾）。
- e：建议是「跟 5.5 一起定」。**5.5 已按 A 拍（2026-11-14）**：本条随之关闭——json / toml 宿主（claude-code / gemini-cli / codex）的 `hook` 检查与 codex 信任表复算已随 §5.5 落地，见 §5.5 末尾。

**2026-11-15 真宿主走查复跑（§5.5 / §5.9 / §5.10 落地后的实机确认）**：临时 hub + 各宿主临时 home，真 `ck` 进程跑 setup / doctor，再用真宿主自己的只读命令读回。四宿主 21 项全绿：

- **codex（0.166.0，9 项）**：doctor 十项全绿（`points_to_self: true`、信任表复算 `trust_entry_present / trust_enabled / trusted_hash_matches` 全 true、`cache` 项出现）；`codex mcp get ck` 读回正斜杠条目；换 `--agent` 重跑两个文件都 `update`、exit 0（5.9），hooks.json 指向新 Agent 且信任表跟着换、doctor 复查仍全绿。
- **hermes（v0.23.0，5 项）**：doctor 十项全绿（hook + approved + cache）；临时 `HERMES_HOME` 首跑经 `hermes pm repair` 暖机（一次性 Python 依赖安装）后，`hermes hooks doctor` 报 `✓ allowlisted`、`hermes mcp list` 列出 ck（`✓ enabled`、`all` tools，正斜杠命令）。
- **gemini-cli（0.68.0 npx 缓存，3 项）**：doctor 十项全绿（hook 项）；`gemini mcp list` 读出完整条目（正斜杠 args）。`GEMINI_CLI_HOME` 语义实跑确认是 homedir 替代（settings 在 `<GEMINI_CLI_HOME>/.gemini/settings.json`），与 `agents/gemini-cli/README.md` 的写法一致；临时 cwd 未信任时条目标 `Disabled` 是 gemini 自己的信任机制，条目本身可读即达验证目标。
- **claude-code（4 项）**：doctor 十项全绿（hook 项）；settings.json 的 hook 命令是正斜杠路径；该命令经 cmd.exe 实跑返回 `SessionStart` JSON，`additionalContext` 带真实配装 digest（正斜杠 + §6.9 的关键路径实测）。

hermes / gemini 的单宿主走查脚本已收进 `scripts/`（`walk-hermes.mjs`、`walk-gemini.mjs`，2026-11-16）：REPO 从 `import.meta.url` 推导、宿主二进制可 `HERMES_BIN` / `GEMINI_BIN` 覆盖；当时 `%TEMP%` 里的 `ck-walk-realhosts.mjs` 已不存在，codex / claude-code 走查步骤以本节文字为准。UI 实测 / 截图走查同样入库（`scripts/ui-measure.mjs`、`scripts/ui-shoot.mjs`，浏览器可 `CHROME_PATH` 覆盖）。仍未做的实机项只剩：真 codex / gemini 的**会话内**验证（模型回合，§2.5 / §2.4 的口径）与 5.13 c（gemini 实机 resume——2026-11-16 实测被账号侧硬拒，本机 Google 账号的 Gemini 服务因 ToS 被禁，换凭据后重跑 `%TEMP%\ck-gemini-resume.mjs` 即可，见 §5.13 c 条）。

## 6. 观察项与设计问题

代码都没动。

### 6.1 skill 标记文件的 `agents[]` 在版本重写时被重置（F8）

多个宿主、多个 Agent 共用一个物理 skill 目录时，标记文件靠 `agents[]` 记「谁在用」。版本重写会把它重置成当前这一个 Agent。重置和取并集都有失败的情形：重置会丢掉别的 Agent 的登记，并集会留下早已不用它的 Agent。要彻底解决，标记里得按 Agent 记录各自想要的版本。本机三个宿主共用一个目录（§1），这个问题在这里是真实存在的。

### 6.2 `ck doctor` 的解析探针用的预算不对（F11）

`resolve` 检查只取 `host.budgets.instructions`。Claude Code 的声明里只有 hook 预算（8,000 字符），于是探针按 hub 的默认预算解析，量出来的不是 hook 实际会拿到的那一份。一行的改法：取 `host.budgets.instructions ?? host.budgets.hook`。

**已修（2026-11-16，decisions O-42）**：探针预算取 `instructions ?? hook`，与 sync.ts / mcp.ts 同口径；§6.11 末条「对 codex / gemini-cli / hermes 同样成立」随之消掉。

### 6.3 宿主配置文件不存在时 `ck doctor` 没有提示（F5）

文件在、条目不在时有 ``hint: "run `ck setup --write` for this host"``；文件本身不存在时只有 `exists: false`。cinlan-harness 现在就是后一种（§2.2）。

**已修（2026-11-16，decisions O-42）**：文件不存在时也给同一条 hint（generic 这类无声明文件的宿主不提示）。

### 6.4 吊销之后，已物化的 skill 还在磁盘上

吊销时配装缓存会删，skill 目录不动（§3 第 57 项）。loadout.md §4 第 6 条「吊销即失效……不注入任何资产内容」管的是注入；已经落盘的 skill 正文，宿主照样会加载。要不要在吊销时清掉，文档没有说。

### 6.5 brief 宿主在 hub 停机时两条通道不一致

Claude Code 上 hub 停机时，`ck hook` 用缓存兜底（缓存提示 + 缓存正文），同一时刻 `ck mcp` 的 `instructions` 却是 `UNAVAILABLE` 错误块（§3 第 62 项）：brief 不走缓存。模型会同时看到「配装来自缓存」和「读档失败」。

### 6.6 物化每次都去取 skill 正文

`ck mcp` 的后台物化不看本地标记里的版本，每次都向 hub 取。hub 停机时会多出一条 `mcp.skills_failed`（§3 第 66 项）。可以在标记版本等于解析结果里的版本时跳过。

### 6.7 非吊销类的 4xx 也按「hub 不可达」处理

读档路径上，除了 `401 / 403 / 404`，其余失败只要有缓存就回落，并带上「hub 暂不可达」的提示。`400`、`409`、将来的 `429` 也走这条路，提示语与事实不符。P2 做按 key 限流时，要先定客户端对 `429 + Retry-After` 的反应。

### 6.8 还在调 `process.exit()` 的出口

F13 之后剩下这些：`die()`（单次请求失败后调用，实测 10 次都干净）；分发器最外层的兜底 catch；`cmdMcp` 的 2 秒保底（带 `unref()`）；`cmdSetup`（不走网络）。另外，`cmdSkills` 在物化超时的情况下进程可能多挂 10 秒左右才退出。

### 6.9 Windows 上 hook 命令由哪个 shell 执行

写进 `settings.json` 的是 `node "<反斜杠路径>" hook session-start …`。cmd.exe 与 PowerShell 下实测通过；Git Bash 下反斜杠在双引号里一般也原样保留，但本机没装在常规路径，未验证。Claude Code 在 Windows 上用哪个 shell 跑 hook，需要在 §2.4 里看一眼。5.10 的方案 A 能顺带消掉这个不确定。

### 6.10 零碎

- `.bak` 只有一代：每次真正改写文件都会用当时的内容覆盖 `<file>.bak`。第二次真正的改动之后，接入前的原件就没了。幂等的重复执行不产生改写，不受影响。**2026-11-15：5.9 落地后「同名条目不同内容」也走 update（`.bak` 留接管前内容），接入前原件同样只有一代——仍未解决，需要时手工另存。**
- `setup.ts` 的报错有笔误：`host generic declarations host no MCP config file`。**已修（2026-11-15，随 5.11）：改为 `declares no MCP config file; use \`ck setup --host generic\` to print a manual snippet`。**
- `hook.ts` 的 catch 里有一个没被用到的 `const ctx: McpContext`。**已修（2026-11-16，O-42）**：死块与 import 一并删除。
- 测试的临时目录有泄漏：cli 套件每跑一次留下 3 个 `ck-mcp-*`（三个投递完整文本的测试，结束时后台的「已上报」标记还没写完）。改法是在这三个测试里等标记文件出现。**已修（2026-11-16，O-42）**：三个上报测试等 marker digest 落地，「过期标记」测试等 marker 的 `at` 变新（重写时 digest 相同）；实测整套跑完 `%TEMP%` 零新增，历史积压 255 个已清。

### 6.11 P2 宿主适配走查的观察项（2026-11-14）

来源同 5.13。代码都没动。

- 往 CRLF 的 `config.toml` / `config.yaml` 追加的块是 LF，文件变成混合换行。
- win32 上 `LOCALAPPDATA` 未定义时，hermes 声明里的 `%LOCALAPPDATA%/…` 不展开，`ck setup --write` 会在当前目录下建出名字就叫 `%LOCALAPPDATA%` 的目录。`ck import` 遇到同一情形是记 note 跳过。
- `--agent` 只查 `<team>/<name>` 的结构，不查字符集。`ck setup` 不连 hub，`core/a;calc` 这样的值会原样写进宿主配置里的 hook 命令行（hub 的 `ensureAgent` 要求 slug，这种名字本来也注册不上）。
- `host.json` 写坏时 `hostConfig` 静默退回内置表。`hosts.ts` 的注释说 doctor 会报出来，doctor 里没有这一项。
- 6.2 的预算问题对 codex / gemini-cli / hermes 同样成立（声明里都只有 hook 预算 8,000）。
- gemini-cli 的 `settings.json` 允许带注释，带注释的文件 `ck setup` 按「不是合法 JSON」报 `conflict` 不写。
- opencode：用户只有 `opencode.jsonc` 时，`ck setup` 会在旁边新建一份 `opencode.json`。两份并存时 opencode 怎么合并，没有验证（本机未装）。
- hermes allowlist 的两处小差异：`approved_at` 是 JS 的毫秒格式（hermes 只拿它显示）；文件带 UTF-8 BOM 时 hermes 读得了，`ck setup` 报 `conflict`。

## 7. 运行时产物与清理

我没有删任何东西。验收全部结束后按下面清理。

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| 进程 pid 31872、19444 | 种子脚本与 hub | 停掉 31872（Ctrl-C 或结束进程），确认 19444 随之退出 |
| `%TEMP%\ck-acceptance-live\` | hub 配置、库、日志 | 停 hub 后删除 |
| `%TEMP%\ck-acceptance-live.seed.out`、`.seed.err` | 种子脚本输出，**含 demo 与 probe 两把 key 的明文** | 验收完删除 |
| `C:\Users\ASUS\.cinlan-knowledge\` | `config.json`、`key`、`cache\`（三个 Agent 的 agent / loadout 缓存与上报标记）、`logs\ck.log`（8 行：3 条 `mcp.started`、3 条修复前的 `mcp.skills_conflict`、2 条我验证 F14 时留下的 `hook.failed`；无 key、无正文） | 指向验收 hub。接正式 hub 时重新 `ck login`，`cache\` 删掉 |
| `C:\Users\ASUS\.agents\skills\acceptance-checkpoint\` | 验收 skill，三个宿主都看得到 | 验收完删除；重新跑种子之前也要删 |
| 真实宿主配置 | 我没有写过 | 你执行 §2.4 A 之后，按手册 §1.6 反向清理：删掉标记块 / `mcpServers.ck` / hook 条目，或还原 `.bak`；`.bak` 文件一并删 |
| `%TEMP%\ck-acc-isolated.mjs`、`.json` | 隔离实测的脚本与结果 | 留着备查，或删除 |
| `%TEMP%\ck-acc-probe.mjs`、`ck-acc-probe-{dsh,clh,cc}.json` | `ck mcp` 探针与结果 | 同上 |
| `%TEMP%\ck-acc-verify*.out`、`.err`，目录 `ck-acc-verify-045008`、`ck-acc-verify2-045256`、`ck-acc-verify3-045451` | 种子脚本自测时的三个一次性 hub。`.out` 里有那几个 hub 的 key 明文，hub 早已不在 | 删除 |
| `%TEMP%\ck-exit-min.mjs`、`ck-exit-min2.mjs`、`ck-exit-probe.mjs`、`ck-resolve-dsh.json` | F13 的最小复现与探针 | 删除 |
| `%TEMP%\ck-t8-check.mjs`、目录 `ck-t8-2MN0hm` | 你上一轮 T8 的脚本与数据 | 没动 |
| `%TEMP%\ck-mcp-*`、`ck-core-*`、`ck-asset-*` 等 | 测试套件的临时目录残留（§6.10） | 删除 |

## 8. 复现方式

```powershell
# 全量测试（预期 core 39 + mcp 14 + hub 26 + cli 126，fail 0）
pnpm --dir D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge -r build
pnpm --dir D:\Company\cinlan\apps\cinlan-harness-plugin\cinlan-knowledge -r test

# 隔离实测（自带一次性 hub 与假 home，不碰真实用户目录；结果写到 %TEMP%\ck-acc-isolated.json）
node $env:TEMP\ck-acc-isolated.mjs

# hub 侧五项
node <ck> rpc auth/verify '{}'
node <ck> rpc team/list '{}'
node <ck> rpc loadout/resolve '{"agent_id":"agt_9e9cc5e8d39b4eb96b382ca1","max_bytes":24000}'
node <ck> doctor
```

JSON 参数是 PowerShell 7 的写法；Windows PowerShell 5.1 里内层双引号要写成 `\"`。

隔离实测与探针脚本放在 `%TEMP%`，沿用上一轮 T8 脚本的做法，没有进仓库。要把它们留作回归用，可以挪进 `scripts/`，告诉我一声即可。
