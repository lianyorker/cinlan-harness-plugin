# 实机验收手册

对着走完一个宿主约 20 分钟。本文只做三件事：起环境、验四项、出事怎么查。

- 验收点来源：[install.md](install.md) §7 的宿主侧四项。
- 四个宿主侧检查的编号：**C1 状态自检 / C2 读档问答 / C3 跨用户隔离 / C4 吊销失效**。
- 所有命令在仓库根或任意目录执行均可；`ck` 指 PATH 里的 `ck`。仓库内调试也可用 `node <仓库>/packages/cli/lib/bin.js` 代替（见 §0.3 的 `/dl` 说明）。

---

## 0. 准备（做一次）

### 0.1 起验收环境

```bash
node scripts/seed-acceptance.mjs
```

控制台输出（示例）：

```
=== 验收数据已就绪（Ctrl-C 只停 hub，不删数据）===

hub      http://127.0.0.1:60467
数据目录 C:\Users\ASUS\AppData\Local\Temp\ck-acceptance-1762...
团队     acceptance
用户     demo（Team Admin） + probe（member，仅用于跨用户隔离验收）
模板     acceptance-tpl（记忆 inject + skill inject）
记忆     验收标记-CHECKPOINT（暗号 BLUE-FALCON-42）
skill    acceptance-checkpoint

用户 key（一次性，只用在这个临时 hub 上；登录后从控制台消失）：

  demo  ck_xxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
  probe ck_xxxxxxxx_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
```

记下 **hub 地址、demo key、probe key** 三样。脚本按 Ctrl-C 只停 hub，不删库；验收中途要重来，重跑脚本会新起一个库，旧的目录按它打印的清理提示删。

数据目录里有 `hub.json`（配置）、`data/knowledge.db`（库）、`hub.log`（hub 日志）。hub 起不来先看 `hub.log`。

### 0.2 先过 hub 侧五项

```bash
curl -fsS http://127.0.0.1:<port>/healthz          # {"ok":true}
ck login --hub http://127.0.0.1:<port>            # 粘贴 demo key，回车；输出 {"ok":true,...}
ck rpc auth/verify '{}'                            # code 0，data.server_version 非空
ck rpc team/list '{}'                              # 含 acceptance
```

`ck login` 把 key 写到 `~/.cinlan-knowledge/key`（Windows：`%USERPROFILE%\.cinlan-knowledge\key`），只读一次 stdin，不落 shell 历史。

第四项是配装解析，拿到 agent_id 后才能做：

```bash
ck rpc agent/ensure '{"team":"acceptance","name":"demo-dsh","host":"dsh"}'
# 或对任一宿主名重复；输出 data.agent.id 形如 agt_...
ck rpc loadout/resolve '{"agent_id":"agt_...","max_bytes":24000}'
# data.text 含「验收标记-CHECKPOINT」；data.skills[] 含 acceptance-checkpoint
```

hub 侧不过，宿主侧不用开始。

### 0.3 关于 `ck` 的安装

`install.md` §5 的 `npm i -g http://<hub>:8424/dl/ck.tgz` 依赖 hub 的 `<dataDir>/dl/` 里有发布包——种子 hub 没有，会 404。验收时用下面任一方式：

- 仓库内：`node D:/.../cinlan-knowledge/packages/cli/lib/bin.js <子命令>`（先 `pnpm -r build`）；
- 或本机已安装的正式版本 `ck`（版本随 hub 走，以 `ck --version` 与 `auth/verify` 的 `server_version` 对比为准）。

后文命令统一写 `ck`。

---

## 1. dsh

### 1.1 写配置

```bash
ck setup --host dsh --agent acceptance/demo-dsh
```

dry-run，预期（只打印状态和路径）：

```
update    <home>/.dsh/cordis.patch.yml
dry run: re-run with --write to apply
```

状态看文件现状：文件不存在是 `create`；文件已在、还没有 ck 的标记块是 `update`；标记块已是这份内容是 `unchanged`。dry-run 不打印将写入的内容——这一点与 [install.md](install.md) §5、[hosts.md](hosts.md) §4.1 的说法不一致，待决，见 [acceptance-report.md](acceptance-report.md) §5。

再写：

```bash
ck setup --host dsh --agent acceptance/demo-dsh --write
# wrote 1 file(s)
```

配置落点：`~/.dsh/cordis.patch.yml`（Windows：`%USERPROFILE%\.dsh\cordis.patch.yml`），MCP 条目 `serverName: ck`、`transport: stdio`、插件 `@deepseek-ai/dsh-mcp-client`、参数 `mcp --host dsh --agent acceptance/demo-dsh --baseline full`。已有文件会先备份为 `.bak`。

dsh **没有 hook**：读档文本走 `instructions`（host.json 里 `budget_chars 12000` / `max_bytes 24000`，低于 dsh 的 32,768 上限）。改完配置要从托盘完全退出再启动 dsh。

### 1.2 检查 C1：状态自检

新会话里让模型调：

```
knowledge_status
```

预期（字段以 `packages/mcp/src/tools.ts` 为准）：

```json
{
  "hub": { "ok": true, "server_version": "0.1.0" },
  "user": { "name": "demo", ... },
  "team": { "name": "acceptance" },
  "agent": { "name": "demo-dsh", "host": "dsh" },
  "host": "dsh",
  "baseline": { "delivery": "full", "digest": "..." },
  "loadout": { "items": 2, "downgraded": 0, "skipped": [] },
  "reviews": { "pending": 0 }
}
```

判定：`hub.ok = true`、`team/agent` 正确、`loadout.items ≥ 1`、`skipped` 为空。
注意：`knowledge_status` 当前**不返回 `stale` 字段**（`baseline.stale` 只在内部类型里存在）；缓存/降级行为用 C4 与 §3.4 的方式验，别在这里找 `stale: false`。

### 1.3 检查 C2：读档问答

同一会话里直接问模型：

> 验收暗号是什么？

能答出 **BLUE-FALCON-42** 即通过。答不出但 C1 的 `items` 非空：说明 instructions 没进系统提示——查 dsh 的 MCP 日志与 `ck doctor --host dsh` 的 `resolve.bytes`。

### 1.4 检查 C3：跨用户隔离

1. 让模型 `knowledge_save` 一条记忆，标题 `验收私有-<你的名字>`，正文任意。
2. 用 probe 的 key 搜：

```bash
CK_USER_KEY=<probe key> ck rpc asset/search '{"query":"验收私有"}'
# 预期 code 0，data.hits 为空数组
```

搜到就是泄露，停，报 bug。

### 1.5 检查 C4：吊销失效（放最后做）

```bash
# 1. 先发一把备用 key（自己给自己发即可），把新 key 记下来
ck rpc user-key/create '{"name":"acceptance-spare"}'
# 2. 确认当前 key 的 prefix（ck_ 后的 8 位十六进制）
ck rpc user-key/list '{}'
# 3. 吊销当前在用的那把
ck rpc user-key/revoke '{"key_id":"key_..."}'
# 4. 用备用 key 重新登录，恢复可用状态
ck login --hub http://127.0.0.1:<port>     # 粘贴 acceptance-spare 的 key
```

吊销后、重新登录前，在 dsh 里开**新会话**：

- `knowledge_status` 预期 `hub.ok = false` 且 `error` 含 `UNAUTHORIZED`；
- 没有任何配装文本注入（问"验收暗号"，模型答不出）。

吊销的 key 重新登录会失败（`key rejected: UNAUTHORIZED`），这是正常的，用备用 key。

### 1.6 收尾

- 恢复：`ck login` 换回备用 key 后，dsh 新会话应回到 C1 的正常结果。
- 反向清理：`ck setup --host dsh --agent acceptance/demo-dsh` 此时显示 `unchanged`；验收完把 `.dsh/cordis.patch.yml` 里的 `# >>> cinlan-knowledge` 块删掉（或还原 `.bak`）。

---

## 2. cinlan-harness

流程与 dsh 同构（同一个 MCP 插件、同一种 yaml 插入、同样 `full` 预算），差异只有配置落点和 Agent 名。

### 2.1 写配置

```bash
ck setup --host cinlan-harness --agent acceptance/demo-clh --write
```

配置落点：`~/.clh/cordis.patch.yml`。clh 自己的 home 解析顺序是 `$CLH_HOME` → `$CINLAN_HARNESS_HOME` → `~/.clh`（不读 `DSH_HOME`），但 `ck setup` 不展开这些变量，只写 `~/.clh/cordis.patch.yml`。设过变量的机器上，把这个文件（或其中带起止标记的那一块）手工挪到变量指向的目录，见 `agents/cinlan-harness/README.md`。dsh 同理（`$DSH_HOME`、profile 目录）。

改完重启 clh。

### 2.2 检查 C1–C4

与 §1.2–§1.5 完全相同，把 Agent 名换成 `acceptance/demo-clh`、宿主换 cinlan-harness：

```
knowledge_status        # agent.name = demo-clh，host = cinlan-harness，items ≥ 1
验收暗号是什么？        # BLUE-FALCON-42
CK_USER_KEY=<probe key> ck rpc asset/search '{"query":"验收私有"}'   # hits 空
（吊销 + 新会话）        # UNAUTHORIZED，无注入
```

### 2.3 注意

- dsh 与 clh 共用 skill 目录 `~/.agents/skills`。若两个宿主同时接同一 Agent 名，skill 物化会互相顶；验收时各用各的 Agent 名（`demo-dsh` / `demo-clh`）即可。
- `ck doctor --host cinlan-harness` 从 yaml 的标记块里读 `--agent`。文件在、块不在时提示 `run ck setup --write for this host`；文件本身不存在时没有这句提示，只有 `host_config.ok = false`、`exists: false`。

---

## 3. Claude Code

### 3.1 写配置

```bash
ck setup --host claude-code --agent acceptance/demo-cc
```

dry-run 会列出**两个**文件（装过 Claude Code 的机器上两个文件都已存在，状态是 `update`；不存在才是 `create`）：

```
update    <home>/.claude.json               # mcpServers.ck（stdio MCP）
update    <home>/.claude/settings.json      # hooks.SessionStart（startup|clear|compact）
```

写入：

```bash
ck setup --host claude-code --agent acceptance/demo-cc --write
```

两个 JSON 都是深合并，不动别人的键；已有文件先留 `.bak`。改完重启 `claude`。

Claude Code 的送达方式与 dsh 不同：MCP 侧只带 `brief`，读档正文由 `SessionStart` hook 输出（预算 8,000 字符）。payload 是 `hookSpecificOutput.additionalContext`。

### 3.2 检查 C1：状态自检

新会话（`startup` 会触发 hook）里：

```
knowledge_status
```

预期同 §1.2，其中 `baseline.delivery = "brief"`、`agent.name = demo-cc`、`host = claude-code`、`loadout.items ≥ 1`。

### 3.3 检查 C2：hook 读档

新会话第一句话直接问：

> 验收暗号是什么？

答出 **BLUE-FALCON-42** 即通过——这条内容只存在于 hook 输出的 `additionalContext` 里，答得出说明 hook 生效。

三个触发点都要过：`startup`（重启后新会话）、`clear`（`/clear` 后问一次）、`compact`（长会话触发压缩后问一次）。

### 3.4 检查 C3–C4

同 §1.4、§1.5。C4 额外看一眼 hook 的失败形态：吊销后新会话里 hook 应输出错误块（`团队记忆中枢本次读档失败：UNAUTHORIZED`），进程不报错、会话正常打开。

注意：`knowledge_status` 不带 `stale`。hub 停机时的 stale 提示是配装文本前面的一行 `<cinlan_knowledge_notice stale="true" ...>`：Claude Code 上它在 hook 输出里，dsh / clh 上在 MCP `instructions` 的开头。要验它：先正常开一次会话落缓存，再停 hub，`/clear` 后问暗号——应能答出，且上下文里带 stale 提示。

---

## 4. 通用排错

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 宿主里看不到 `knowledge_*` 工具 | `ck doctor --host <h>` 的 `host_config` | 配置没写进去：重跑 `ck setup --write`；dsh/clh 从托盘完全退出再启；Claude Code 重启进程 |
| MCP 初始化失败 / 宿主报错 | `ck doctor --host <h>` 的 `resolve.bytes` | 送达文本超宿主上限（dsh 32,768 字节）：查 `loadout/resolve` 的 `bytes`，调小注入项或 `max_bytes` |
| `knowledge_status` 报 `UNAUTHORIZED` | `ck rpc auth/verify '{}'` | key 错/被吊销/过期；`ck login` 重登 |
| `knowledge_status` 报 `NOT_FOUND`（agent） | `ck rpc team/list '{}'` | `--agent` 的 team/name 写错，或不是该团队成员 |
| `loadout.items` 为空 | `ck rpc agent/get-default-template '{"team_id":"..."}'` | 团队没设默认模板或模板为空；种子脚本已设，重跑种子复查 |
| `skipped[].reason = no_access` | 绑定资产的可见性 | 重新共享或从配装移除 |
| `skipped[].reason = budget` | `resolve.bytes` 与预算 | 调小条目、提高预算，或把长内容改 `tool` 注入 |
| hook 输出变成"文件路径 + 预览" | Claude Code 侧 hook 预算 | `host.json` 的 `hook.budget_chars` 应为 8,000，不要调高 |
| skill 已物化但宿主没发现 | `~/.agents/skills` / `~/.claude/skills` 下的目录与标记文件 | 重启宿主；`ck skills sync --host <h> --agent <a>` 强制重物化；标记冲突按提示人工处理 |
| 配装改了当前会话没变 | 每会话只注入一次 | 开新会话，或 `knowledge_status {"reload": true}` |
| hub 起不来 | 种子目录里的 `hub.log` | 按日志逐条改；端口被占就重跑脚本（会另选端口） |

## 5. 验收记录模板

每个宿主一行，附证据（`knowledge_status` 输出片段 / C2 问答截图 / C3 的 `hits` 为空 / C4 的错误块）：

```
宿主           C1  C2  C3  C4  备注
dsh            [ ] [ ] [ ] [ ]
cinlan-harness [ ] [ ] [ ] [ ]
claude-code    [ ] [ ] [ ] [ ]
```

全部勾上后，把 sop.md §C 的「实机验收」一项勾掉。
