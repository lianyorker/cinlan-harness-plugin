# @cinlan/clh-knowledge-sync

deepseek-harness 的跨实例 / 跨节点记忆与 skills 共享插件。两部分组成：

- **节点插件**（`@cinlan/clh-knowledge-sync`）：挂在 harness 组合里，把本地记忆（markdown）和 skills 同步到远程总记忆库，并拉取其他节点共享的内容；同时向 harness 工具流水线注册 4 个模型工具（搜索总库 / 拉共享 / 推本地 / 查状态）。
- **hub 总记忆库**（`@cinlan/clh-knowledge-sync-hub`）：独立 HTTP(S) 进程，集中存储所有已审批条目；推送一律先进待审批队列，管理员批准才发布；提供检索、拉取、审批、清理全流程。

所有连接参数（协议、地址、端口、TLS、token）全部来自配置文件，支持 `${ENV}` 环境变量插值，零硬编码地址。

## 目录结构

```
clh-knowledge-sync/
├── src/                  # 源码（TS，构建到 lib/）
│   ├── index.ts          # 节点插件主入口（cordis 服务）
│   ├── tools.ts          # 4 个模型工具（clh-knowledge-sync/tools 子路径）
│   ├── config.ts         # 配置 schema（Schemastery）+ hub 配置校验 + ${ENV} 插值
│   ├── hub/              # hub：server.ts 路由与认证 / store.ts 存储 / cli.ts 命令行 / main.ts 入口
│   └── node/             # 节点：engine.ts 同步引擎 / local-store.ts 本地存储 / http-client.ts
├── bin/                  # clh-knowledge-sync-hub.js（hub 进程）、clh-knowledge-sync.js（CLI）
├── client.js             # 手写 __ModuleLoader__ 浏览器包：Settings → DeepSeek 同步 配置页
├── config/               # 示例配置（内网 http / 外网 https / 节点双 profile）
├── cordis.patch.yml      # 组合包补丁：向 profile 插入服务行 + 工具行
└── demo/                 # 端到端验收（node demo/e2e-demo.mjs，18 项断言）
```

## 快速开始

### 1. 构建

```bash
cd clh-knowledge-sync
npm install
npm run build
```

### 2. 启动 hub（内网 http）

```bash
export DSS_ADMIN_TOKEN=...      # 管理员 token
export DSS_TOKEN_NODE_A=...     # 各节点 token
node bin/hub.js --config config/hub.example.json
```

外网部署用 `config/hub.example.extranet.json`：`protocol: "https"` + `tls.certFile/keyFile`，另需 `DSS_TLS_CERT`、`DSS_TLS_KEY`。token 也可直接写进配置（不建议提交到版本库）。

### 3. 节点接入

插件安装进 harness（树外组合包）：

```bash
clh plugin --profile <name> add file:<本包路径>
```

注意 `plugin` 是 clh 的子命令、要放在最前面；`clh --profile <name> plugin add ...`（子命令在后）会被当成「启动该 profile 并把 `plugin add ...` 作为 app 参数透传」，实际是把应用跑起来而不是装插件——本机 2026-11-08 的"挂起"就是这个原因，未做任何 profile 变更，也未进入 plugin-manager。安装全链路未实测，见下方「已验证 / 未验证」。

安装后 profile 里会多两行（来自 cordis.patch.yml）：`clh-knowledge-sync`（同步服务）与 `clh-knowledge-sync/tools`（模型工具，依赖 base profile 的 tools 服务，缺失时保持 PENDING，不影响前者）。

节点配置（cordis.yml 里的 `clh-knowledge-sync` 行，或 CLI 用 JSON）：

```yaml
- id: clh-knowledge-sync
  name: '@cinlan/clh-knowledge-sync'
  config:
    node: { id: node-a, token: !!js process.env.DSS_TOKEN_NODE_A }
    hub:
      activeProfile: intranet        # 内网用 intranet，外网切 extranet；名字任意，字典结构
      profiles:
        intranet: { protocol: http, host: 10.0.0.5, port: 47610 }
        extranet:
          protocol: https
          host: hub.example.com
          port: 47611
          token: !!js process.env.DSS_TOKEN_NODE_A_EXTRANET
          tls: { rejectUnauthorized: true }
    sync:
      auto: true                     # 自动同步（push→status→pull 每 intervalSec 一轮）
      intervalSec: 300
      memoryDir: ./memory            # 本地记忆目录（*.md，frontmatter id/expiry/tags）
      skillRoots: ['./skills']       # 本地 skills 目录（每个子目录一个 skill，含 SKILL.md）
```

内网 / 外网切换：改 `hub.activeProfile` 即可，两套地址互不影响；缺 token 或 profile 不存在时配置校验直接报错（列全所有问题），不会静默启动。

### 3.1 设置界面（免改 YAML）

桌面/浏览器面板里 **Settings → 记忆与技能同步（Memory & Skills Sync）** 即是本插件的配置页：节点 ID/令牌、hub 连接与 profile、同步周期与目录、一次性运行、日志都能直接编辑保存。

- 写回通道是 host `settings` 服务 → profile `cordis.patch.yml` 的用户层 override；与手改 YAML 等价且持久。
- 生效方式：schema 里的可编辑分组标了 `.volatile()`，保存后免 remount，服务接 `internal/update` 原地重建运行时（停旧引擎→按新配置重建 client/local/engine→恢复同步循环）。
- `node.token`、`hub.profiles.*.token` 标了 `role('secret')`：设置页按只写处理（只提交、不回显），describe 输出也脱敏。
- 实现：`package.json` 的 `dsh.client`（`platform:web` + inject 依赖包）+ `exports["./client"]` → `client.js`（手写 `window.__ModuleLoader__.load({id,factory})` 形态，`react` 等模块表 seed 免打包）。

### 4. 同步行为

- **自动同步**：`sync.auto: true` 时按 `intervalSec` 周期执行 推送→回读审批状态→拉取。
- **手动推送**：CLI `clh-knowledge-sync --config node.config.json push`（`--force` 覆盖总库版本，`--memory`/`--skills` 只推一类）；oneshot 模式（`oneshot.enabled: true`）在无界面环境跑完指定指令后写 resultFile 并按成败退出。
- **同 id 不同内容**：推送返回 `conflict`（带 serverVersion），本地日志 WARN 并记录 conflicts；拉取侧把总库版本保全为 `conflicts/` 下的冲突副本，不覆盖本地。
- **审批回读**：被拒条目 status 变 `rejected` 并带 reason；批准条目带 `version`。

### 5. 审批与清理（管理员）

REST（`/api/v1/admin/*`，Bearer adminToken）或 CLI：

```bash
clh-knowledge-sync admin --hub-config hub.config.json pending          # 待审批列表
clh-knowledge-sync admin --hub-config hub.config.json decide <queueId> approve|reject [原因]
clh-knowledge-sync admin --hub-config hub.config.json cleanup-scan [--older-than-days=N] [--expired-only]
clh-knowledge-sync admin --hub-config hub.config.json cleanup-propose memory:mem-xxx --reason=过期
clh-knowledge-sync admin --hub-config hub.config.json cleanup-decide approve --ids memory:mem-xxx --reason=确认清理
clh-knowledge-sync admin --hub-config hub.config.json stats
```

- 推送永远进 `pending/`，批准才进 `published/`，拒绝必须带原因、进 `rejected/`。
- 清理流程：扫描（按天数/过期标记）→ 提议（条目打 cleanupFlag）→ 管理员决定 → 批准后移入 `archive/` 并生成 tombstone；各节点下次拉取时按 tombstone 自动删除本地共享副本。
- 全程记审计日志 `dataDir/state/audit.jsonl`（push / approve / reject / cleanup-propose / cleanup-approve / pending-replaced 等）。

### 6. 节点侧模型工具

组合包第二行向 harness 注册 4 个工具，模型可直接调用：

| 工具 | 作用 |
|---|---|
| `dss_search` | 检索总库已发布内容（标题/描述/正文/标签打分） |
| `dss_pull` | 拉取共享内容到本地 `memory/shared/` 与 `skills/`（带来源标记 `.clh-knowledge-sync.json`） |
| `dss_push` | 手动推送本地记忆/skills |
| `dss_status` | 查看同步状态与审批结果 |

## 异常处理（不静默失败）

- **连接失败**：明确报 `connect-failed`（含 profile 名与地址），CLI/oneshot 以非零码退出，节点自动同步记 ERROR 日志继续下一轮。
- **同步冲突**：`conflict` 结果 + serverVersion + WARN 日志 + 本地冲突副本保全。
- **审批被拒**：回读后 status=rejected 并带 reason（WARN 日志）。
- **认证失败**：hub 记 `auth-denied` WARN（含来源地址），返回 401。
- **配置错误**：启动即报，逐条列出全部问题（缺 token、profile 不存在、协议非法等）。
- **审计**：所有审批/清理动作落 JSONL，管理员可追溯。

## 验收

```bash
npm run build && node demo/e2e-demo.mjs
```

端到端 demo 用真实 cordis 加载插件（三个节点 + 一个 hub）：18 项断言覆盖 连接→自动推送→审批门（未审批不可读）→检索→手动推送/冲突→跨节点拉取（含 skill 来源标记）→审批回读→批准后拉取→清理扫描/提议/审批→tombstone 联动删除→连接失败退出码→审计日志→admin CLI。当前 18/18 PASS（本机 Node 24，Windows）。

### 已验证 / 未验证

- 已验证：http 全链路（上表全部）、CLI 全部子命令、`${ENV}` 插值（hub 与节点 JSON 配置）、hub 重启后状态恢复（四区目录 + seq 持久化）；`dsh plugin --profile desktop add file:<本包>` 安装全链路（Desktop 安装版 0.2.2-rc.1，2026-11-08）：依赖落进 profile `node_modules`、bundle 默认启用追加进 `dsh.profile.bundles`；desktop profile 实际运行（2026-11-08）：自动同步按周期执行、推送 1 条进 hub 待审批队列、日志与 `sync-state.json` 落盘持久化。注意安装前需按 CLI 提示授精确版本豁免：`dsh plugin --profile desktop allow-version @cinlan/clh-knowledge-sync@0.1.0 --dsh-version <运行时版本> --accept-risk`（peer 检查按运行时自报版本判定，报错里引用的可能是 installer 元数据版本，以 `allow-version` 命令回显的版本为准）。
- 未在本机验证：真实 https 证书下的 TLS 握手（代码路径按 Node https.createServer 标准写法，demo 里未挂真实证书）；settings 页在运行中的 Desktop 面板里的实际挂载（`dsh.client` 声明、槽位注册与 `configForms` 读写通道按宿主机制实现，需重启 Desktop 后打开 Settings 验证）。

## 新机器部署 checklist（Windows Desktop 实测）

> **完整一次到位教程见 [`INSTALL.md`](./INSTALL.md)**——含逐条命令、config 模板与错误速查表，新机器照做即可装成。下面是浓缩版。

把仓库 clone 到任意目录（例如 `~/.dsh/plugins/cinlan-harness-plugin`）只是**存放源码**——该目录不会被运行时扫描，解析只认 dsh 安装目录 + profile `node_modules` + `$DSH_HOME/profiles/node_modules` 回退。**整仓 clone 是正常形态**：本仓库是 monorepo（根目录没有 `package.json`），只能整仓拉取；但 `plugin add` 的路径必须指到**子目录** `clh-knowledge-sync`，指到仓库根会以 not-a-package 失败；也不要直接 `plugin add <git URL>`——pnpm 会把整仓当成单个依赖拉取，同样不是可安装包。真正安装按以下顺序：

1. `git pull` 到最新；`cd clh-knowledge-sync && npm install && npm run build`。
2. `"<安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <name> add "file:<本包绝对路径>"`（`dsh.cmd` 不在 PATH，用全路径；`plugin` 必须是第一个子命令）。报 `incompatible-version` 时按提示 `allow-version` 授精确豁免后重跑。
3. config override 写进**同一个 profile** 的 `cordis.patch.yml`（`- id: clh-knowledge-sync` 的 id-targeted 行即可，tools 行不用动）。**bundle 装进 A profile、override 写进 B profile，A 的主行会因缺 config 启动即 FAILED。**
4. `memoryDir`/`skillRoots` 写绝对路径（会被 resolve 到 harness 进程 cwd，不是 profile 目录）；统一用 `~/.dsh/clh-knowledge-sync/{memory,skills}`——**自家插件数据目录一律 `clh-` 前缀**，别各机器各起各的目录名。
5. `node.token` 直接写字面值（推荐）。`!!js process.env.X` 取的是 app 启动时的进程 env——`setx` 对运行中进程无效、应用内重启/自启/远程会话继承旧 env，实测「有时挂上有时挂不上」；只 CLI 场景才考虑。
6. 生效与验证：**运行中的会话不会换组合**——改完 patch/装完包要重启 app、开新会话；Settings → 插件页看行状态，或看 `<memoryDir>\.clh-knowledge-sync\logs\` 与 `sync-state.json` 有没有新写入。

### 故障排查

- **`clh-knowledge-sync 主插件行未挂载（ctx.clhKnowledgeSync 不可用）`**：tools 行只 `inject: ['tools']`，主行 FAILED 它照样注册——`memory_search`/`memory_push`/`dss_*` 能出现、调用才报这个错。按序排查：
  1. profile 对不对：报错会话用的 profile == 写了 config override 的 profile（任务/worktree 会话可能跑在别的 profile，profile 列表里没有的 hash 串是 session id，不是 profile）。
  2. 行状态：Settings → 插件页看 `clh-knowledge-sync` 行的 FAILED 原文；或 `dsh.cmd --profile <name> --dump-config` 看组合后的行（`node.token` undefined 或行缺席一目了然）。
  3. 最常见：`!!js process.env.X` 取不到 → token undefined → schema `required()` 拒 → 行 FAILED。**直接换字面 token**——`!!js` 取 app 启动时 env，重启方式不同结果不同，不稳定。
- **改了源码不生效**：`file:` 是拷贝——重建后要 `plugin remove` + `plugin add` 重装，否则 profile `node_modules` 里跑的还是旧副本（`link:` 相反）。
- **`plugin add` 报 `ERR_PNPM_UNEXPECTED_STORE`**：profile 现有 node_modules 链接的 store 与本次调用解析的 store 不一致（CLI 环境缺 `LOCALAPPDATA` 时 pnpm 回落 `~/.pnpm-store`）。首选在同一窗口 `$env:LOCALAPPDATA="$env:USERPROFILE\AppData\Local"; $env:npm_config_store_dir="$env:USERPROFILE\AppData\Local\pnpm\store\v11"` 后重跑；仍失败则 `cmd /c rmdir /s /q` 删 profile `node_modules` + 删 `pnpm-lock.yaml` 后重跑（**禁用 `Remove-Item -Recurse`**，会顺 junction 删 store 真实数据）。
- **会话里 `run_code` 报 `SetNamedSecurityInfoW failed (Win32 5)`**：宿主沙箱给工作目录授 ACL 被拒（目录属主/杀软），与本插件无关，换普通用户目录下的工作区验证。

## 配置参考

见 `config/` 下三个示例：`hub.example.json`（内网 http）、`hub.example.extranet.json`（外网 https + TLS）、`node.example.json`（双 profile + `${ENV}`）。字段说明见 `src/config.ts` 注释与 schema 默认值。
