# 安装与部署

> 目标形态。代码未实现前，本文是实现时要满足的操作面。

## 0. 前置

- hub：Node ≥ 24（`node:sqlite` 的可用版本，见 [decisions.md](decisions.md) O-1），pnpm。hub 自身零第三方运行时依赖（`packages/mcp` 引入官方 MCP server SDK，见 decisions N-1）。
- 宿主侧：Node ≥ 20（`ck` 的运行时要求）。宿主本身不限类型：dsh、Claude Code、Codex CLI、Gemini CLI 或任意支持 MCP 的 agent harness / CLI。
- 一台机器装一次 `ck`，之后每接一个宿主只改该宿主的配置。

## 1. hub 配置

`knowledge.config.json`，**不含任何密钥**：

```jsonc
{
  "dataDir": "/opt/cinlan-knowledge/data",
  "listen": {
    "host": "0.0.0.0",
    "port": 8424,
    // 浏览器与本机客户端之外的来源一律 403；留空表示只允许 hub 自己
    "allowedOrigins": ["http://127.0.0.1:8424", "http://cinlan-hub.internal:8424"]
    // "tls": { "certFile": "/abs/cert.pem", "keyFile": "/abs/key.pem" }
  },
  "limits": { "maxBodyBytes": 26214400, "maxContentBytes": 262144, "maxFileBytes": 5242880 },
  "log": { "level": "info" }
}
```

- 路径一律绝对路径。
- 缺项或类型不对：启动时列出全部问题并以非零码退出。
- 用户、key、团队都在库里，经 panel 或 `ck rpc` 管理，不进配置文件。
- `allowedOrigins` 是 `/api/v1`、`/mcp`、`/panel` 的 `Origin` 校验来源；不带 `Origin` 头的非浏览器客户端（`ck`、服务端 MCP 客户端）不受影响。

## 2. 启动与首个管理员

```bash
pnpm install && pnpm -r build

# 首次：建库 + 建首个 System Admin；key 只打印这一次
cinlan-knowledge bootstrap --config /abs/knowledge.config.json --name yorker

cinlan-knowledge serve --config /abs/knowledge.config.json
# API   :8424/api/v1    MCP  :8424/mcp
# panel :8424/panel/    分发 :8424/dl/ck.tgz
```

开发模式：

```bash
pnpm -F @cinlan/knowledge-hub dev      # :8424
pnpm -F @cinlan/knowledge-panel dev    # :5173，vite 代理 /api → 8424
```

`ck` 的分发包（`/dl/ck.tgz` 的来源）：

```bash
pnpm pack:ck                           # 构建全部包 → dist/ck.tgz（打印 sha256）
# 出线：把 dist/ck.tgz 拷到 hub 的 <dataDir>/dl/ck.tgz，由 /dl 分发（见 §5）
```

自包含 tarball：workspace 依赖（sdk / mcp）与 registry 依赖（zod、MCP server SDK 及其传递依赖）全部打进 `node_modules`（bundledDependencies）。安装机不需要 pnpm、不需要仓库，只要 Node ≥ 20。

`rpc` 是 `ck` 的子命令（hub 的 CLI 只保留 `serve` / `bootstrap` / `backup`），key 取自环境变量（不要写进脚本或 shell 历史）：

```bash
export CK_HUB_URL=http://127.0.0.1:8424
export CK_USER_KEY=<bootstrap 打印的 key>
ck rpc auth/verify '{}'
```

## 3. systemd

`/etc/systemd/system/cinlan-knowledge.service`：

```ini
[Unit]
Description=cinlan-knowledge hub
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/cinlan-knowledge/current/packages/hub/dist/main.js serve --config /opt/cinlan-knowledge/knowledge.config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

发布沿用本仓库惯例：`tar.gz` 解到 `releases/<名>`，symlink 翻 `current`，restart；回滚 = symlink 翻回。`dataDir` 在 release 目录之外。

## 4. Docker

```bash
docker build -t cinlan-knowledge -f deploy/Dockerfile .
docker run -d --name cinlan-knowledge -p 8424:8424 -v ck-data:/data cinlan-knowledge
docker exec cinlan-knowledge cinlan-knowledge bootstrap --config /etc/cinlan-knowledge/knowledge.config.json --name yorker
```

多阶段构建：panel `vite build` + `ck` 打包 → hub `tsc` → 运行层只带产物。单镜像单端口，数据卷 `/data`，`ck` 安装包由镜像内的 `/dl` 提供。

备份：`cinlan-knowledge backup --config <cfg> [--out <dir>]` → `VACUUM INTO` 一份带时间戳的副本，落 `dataDir/backups/`。恢复 = 停服换文件再启动。

## 5. 宿主接入

`ck` 的安装与配置写入（每台机器一次，每个宿主一次）：

```bash
# 1. 装 ck（来自 hub 自己的分发包，版本与 hub 天然配套）
npm i -g http://<hub-host>:8424/dl/ck.tgz

# 2. 登录：key 从 stdin 读，不落 shell 历史
ck login --hub http://<hub-host>:8424   # 交互粘贴 key

# 3. 接一个宿主（默认 dry-run，打印将写入的内容）
ck setup --host claude-code --agent cinlan/cc-ly
ck setup --host claude-code --agent cinlan/cc-ly --write
```

`ck setup` 的行为：

- 默认 dry-run：打印每个文件的状态行，加上 **ck 管的那段内容**（yaml / toml 的标记块、json 的条目、markdown 的规则块）——不打印整个文件，`settings.json` 里别人的 token 不会被回显。`--write` 才落盘。
- 写宿主配置文件（位置与格式由 `agents/<host>/host.json` 声明），写入前留 `.bak`。
- 只做结构化合并：不动别人的条目；同名条目内容一致 → 跳过（幂等）；条目名 `ck` 归 ck 所有（yaml / toml 标记块同口径）→ 内容不同原地更新，不报冲突。剩余冲突只有结构性问题（文件不是合法 JSON、`hooks.<event>` 不是列表、allowlist 根形状不对、yaml / toml 块外有同名 id / 表）；任何一个报冲突，这次执行一个文件都不写。
- 默认接法是 A1：stdio MCP 条目（`node <ck 绝对路径> mcp --host <h> --agent <team>/<name>`）+ 会话开始 hook 条目（`node <ck 绝对路径> hook session-start ...`），文本送达方式与预算由 `host.json` 决定。
- `--transport http` 改为 A0：写远端 `http://<hub>/mcp` 条目与请求头（key 会进宿主配置，仅在内网且装不了 `ck` 时用）。
- 路径一律写正斜杠、绝对路径；Windows 上同样适用（`D:/…` 在 cmd / PowerShell / Git Bash 的双引号里都原样保留）。

各宿主的具体落点：

- **dsh**：宿主配置里加 MCP 条目（`serverName: ck`、`transport: stdio`），配 `--baseline full`；不加 hook（dsh 的 hook 桥接是实验性的，且 `instructions` 进系统提示、能扛住上下文压缩）。见 [hosts.md](hosts.md) §4.2。
- **Claude Code**：MCP 条目 + `SessionStart`（`matcher: startup|clear|compact`）hook，配 `brief`；skill 物化到 `~/.claude/skills/`，依赖宿主的热加载。见 [hosts.md](hosts.md) §4.3。
- **Codex CLI / Gemini CLI**：P2，做法与 Claude Code 同构，落点见 [hosts.md](hosts.md) §4.4。
- **其他宿主**：`ck setup --host generic`（`generic-mcp` 是它的别名）打印手工配置片段（stdio 与 http 各一份，实际路径与 hub 地址已代入），exit 0；或直接用 A0。

`ck doctor` 逐项检查：ck 版本与 `server_version`、hub 连通、key 有效、agent 归属、config 条目存在且指向本机 ck、hook 条目存在、skill 目录可写、缓存状态。skill 目录的判据是「存在且可写，或最近的已存在祖目录可写」（刚 setup 完、还没物化过也能过）；缓存状态是通报项，不计成败。（2026-11-14 按 §5.5 拍板落地）

## 6. 团队开通

管理员侧的操作步骤见 [sop.md](sop.md) §B.1（建团队 → 建人发 key → 建模板 → 设默认模板）。

## 7. 验收清单

```bash
curl -fsS http://<host>:8424/healthz                         # {"ok":true}
ck rpc auth/verify '{}'                                      # code 0，返回 server_version
ck rpc team/list '{}'                                        # 能看到自己的团队
ck rpc loadout/resolve '{"agent_id":"agt_…","max_bytes":24000}'   # text 里有模板里的资产标题
ck doctor                                                    # 全部 ok
```

宿主侧（每个接通的宿主都要过一遍）：

- 新会话里调 `knowledge_status`：`hub: ok`，`agent` 正确，`loadout.items` 非空，`stale: false`。
- 直接问模型一条只存在于团队 `core` 记忆里的约定，能答出来（读档生效）。
- 让模型 `knowledge_save` 一条记忆，换另一个用户的 key 调 `asset/search` 搜不到。
- 吊销当前 key 后开新会话：`knowledge_status` 报 `UNAUTHORIZED`，且没有注入任何内容。

## 8. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 宿主里看不到 `knowledge_*` 工具 | MCP 条目没生效：配置写错位置、`ck` 路径不对、宿主没重启 | `ck doctor`；`ck setup` 重新 dry-run 对比；看宿主自己的 MCP 日志 |
| MCP 连接失败，报初始化错误 | 送达文本超过宿主的 `instructions` 上限（dsh 默认 32,768 字节） | 调小 `host.json` 的 `max_bytes`，或改用 hook / `brief`；`loadout/resolve` 的返回里看 `bytes` |
| 宿主弹出 OAuth 授权、或反复要求登录 | 客户端把 401 当成 OAuth 挑战 | hub 的 401 不带 OAuth 元数据；核对 key 是否正确、是否吊销；见 [api.md](api.md) §2 |
| `knowledge_status` 报 `UNAUTHORIZED` | key 文件/配置项错、key 被吊销或过期、用户被禁用 | `ck login` 重新登录；在 panel `/access` 看 key 状态 |
| `knowledge_status` 报 `NOT_FOUND`（agent） | `--agent` 的 team 或 name 写错，或自己不是该团队成员 | `ck rpc team/list` 核对；让 Team Admin `team-member/add` |
| `loadout.items` 为空 | 团队没设默认模板，或模板为空 | 见 [sop.md](sop.md) §B.5 |
| `skipped` 里有 `no_access` | 绑定的资产被降了可见性或换了 Owner | 重新共享，或从配装里移除 |
| `skipped` 里有 `budget` | 配装超出预算，尾部条目没有投递 | 调小条目、提高 `budget_chars` / `max_bytes`，或把长内容改成 `tool` 模式 |
| `stale: true` | hub 不可达，正在用缓存 | 查网络与 hub 进程；缓存只在网络类故障时使用 |
| Claude Code 里读档变成"文件路径 + 预览" | hook 输出超过 10,000 字符，被宿主改存文件 | 配置里 `hook` 预算应为 8,000 字符，不要调高；超限时 `ck` 会退化为 `brief` 并提示重读 |
| skill 已物化但宿主没发现 | 宿主不支持热加载，或目录不对 | 重启宿主；核对 [loadout.md](loadout.md) §7 的目录；看 `knowledge_status` 的冲突提示 |
| skill 目录里有同名目录但不是我们写的 | 标记文件里的 `asset_id` 不符 | `ck` 不会覆盖，报冲突；人工处理后再 `ck skills sync` |
| 配装改了但当前会话没变 | 每会话只注入一次 | 开新会话，或 `knowledge_status {reload: true}` |
| hub 启动即退出 | 配置校验失败 | 按 stderr 列出的问题逐条改 |
