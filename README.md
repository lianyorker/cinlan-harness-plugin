# cinlan-harness-plugin

deepseek-harness / cinlan-harness **通用插件**（树外组合包）存放地。每个子目录是一个可独立安装的 dsh bundle：通过 `dsh` / `clh` 的 `plugin` 子命令装进目标 profile，靠 `dsh.bundle.patch` → `cordis.patch.yml` 向组合插入插件行。

## 目录约定

| 子目录 | 包名 | 说明 |
|---|---|---|
| `cinlan-knowledge-sync/` | `@cinlan/knowledge-sync` | 跨实例/跨节点知识同步（记忆文件 + skills + 后续习惯/会话记忆）：节点同步服务 + hub 总库进程 + 4 个模型工具。详见 `cinlan-knowledge-sync/README.md` |
| `cinlan-cli-agents/` | `@cinlan/cli-agents` | 外部 CLI agent 通用集成（orca 式声明目录：claude/codex/... 的探测、prompt 注入、headless 运行）：服务 + 2 个模型工具 + 独立 CLI。详见 `cinlan-cli-agents/README.md` |
| `cinlan-redaction/` | `@cinlan/redaction` | 出站脱敏（magpie 式）：llm/stream waterfall 上把敏感值换成稳定 HMAC 占位符、回复换回，规则+词表引擎 + settings 配置页（预览/记录）。详见 `cinlan-redaction/README.md` |

（新增插件在此登记一行。）

## 命名约定

- **包名 `@cinlan/<slug>`**：`cinlan` scope 是本插件线（对齐 `@cinlan/knowledge-*`）。slug 按**能力域**命名，要盖得住负载演进——`knowledge-sync` 装得下记忆/skills/习惯/会话记忆，`skills-sync` 这类只盖子集的名字别用。
- **目录名** = 包名去 scope：`cinlan-knowledge-sync/`。
- **entry id / configForms 命名空间** = `<slug>`（`knowledge-sync`、`knowledge-sync-tools`）——一个名字走到底，Loader 条目 id（`export const name` / patch yml 的 `id`）、settings 命名空间、UI 里 `configForms.get()` 的键全用它，不拆短。
- **服务名** = camelCase basename：`knowledgeSync`（`super(ctx, 'knowledgeSync')` → `ctx.knowledgeSync`）。
- **locale NS** = `settings.<entry-id>`；**bin 命令** = `<slug>` / `<slug>-hub`：`knowledge-sync` / `knowledge-sync-hub`。
- **隐藏状态目录** = `.<包 basename>`（`.cinlan-knowledge-sync`，default `stateDirName`）；**skill 来源 marker** 同名 `.<包 basename>.json`（`.cinlan-knowledge-sync.json`）。改名后遗留的旧名 marker 会被当普通文件同步一次，可接受、不特意兼容。

## 兼容红线：一套代码，两套 harness

本目录的插件必须同时兼容下面两套运行时，**不得偏向任何一边**：

- **deepseek-harness（官方/安装版，Desktop）**：运行时自报 `0.2.2-rc.1`（installer 元数据 `0.2.1-rc.5`）。CLI 自带 Node + pnpm，是官方授予 reserved `desktop` profile 管理权的载体。**双平台已实测**：
  - Windows：安装于 `D:\CodeTools\DeepSeek Harness`，CLI 是 `resources\runtime\cli\bin\dsh.cmd`
  - macOS（Apple Silicon）：安装于 `/Applications/DeepSeek Harness.app`，CLI 是 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（无 .cmd 后缀）
- **cinlan-harness（本仓库 fork 源码树）**：`apps/cinlan-harness`（根目录 `cinlan-harness` junction 同指）。CLI 是 `apps/cli` 构建产物 `clh`（`@cinlan/cli`，当前 `0.2.2-alpha.2`）；cordis / schemastery 由 `vendor/` link 覆盖为 fork 自带副本。

两套 CLI 的 profile 目录默认共用 `$DSH_HOME/profiles/<name>`（默认 `~/.dsh`）——对同一 profile 的装/卸/开关，改动对两边同时生效；要隔离时用 `DSH_HOME` 环境变量分开。

### 依赖规则

- **只依赖 `@deepseek-ai/*` 命名空间的公共包**：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 及其他上游公共包。fork 给上游包保留了原包名，这套命名空间两边都解析得到。
- **禁止依赖 `@cinlan/*`**：fork 私有包在官方 deepseek-harness 里不存在，import 即加载失败（`@cinlan/cli` 等 launcher 侧包同样不行——插件是被 harness 加载的，不是 launcher）。
- harness 依赖一律写 `peerDependencies` + `peerDependenciesMeta.optional: true`；包自身原则上不挂 `dependencies`（确需第三方库要评估两套环境都能装）。版本区间取**两套运行时实际版本的最小交集**：区间下限高于某一边的内置版本就装不进那一边——先降区间（确认所用 API 在该版本已存在），降不动就在 README 写清 `allow-version` 豁免步骤。
- 只用各包 `exports` 声明的公共 API：cordis 的 `Service`/`Context`/`ctx.effect`、Schemastery 的 `Schema`、dsh-tools 的 `defineTool` 等。**不 import 包内未导出路径**——两套构建产物内部布局不保证一致。
- Node 运行时两边都要满足：`engines.node >= 22`（本机开发用 Node 24）。

### package.json 必备形状

```jsonc
{
    "name": "@cinlan/<slug>",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "files": ["lib/**", "bin/*", "cordis.patch.yml"],
  "engines": { "node": ">=22.0.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.6-alpha.1" },
  "peerDependenciesMeta": { "@deepseek-ai/cordis": { "optional": true } },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `dsh.bundle.patch` 声明组合包补丁；`cordis.patch.yml` 用 `- insert:` 插行（每行 `id` + `name`，`name` 可指 `exports` 子路径，如 `'@cinlan/knowledge-sync/tools'`）。
- `files` 白名单必须含 `cordis.patch.yml` 和 `lib/`（或等价构建产物），漏了会让 `file:`/`npm pack` 安装丢文件。
- 行内如需依赖其他插件行（如 base 的 `tools` 服务），在宿主行缺失时应保持 PENDING 而非拖垮整组——设计补丁时让无依赖行先独立可挂。
- 构建产物进 `lib/`（`tsc -p tsconfig.json`）；装 `file:` 的拷贝语义要求安装前已构建。

## 安装

**官方安装版（Desktop）**——用安装目录自带载体，自带 node/pnpm。Windows 与 macOS 命令分别如下：

```cmd
"D:\CodeTools\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:<本包绝对路径>"
"D:\CodeTools\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove @cinlan/<plugin-name>
```

macOS：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "file:<本包绝对路径>"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove @cinlan/<plugin-name>
```

**源码树（clh）**：

```bash
clh plugin --profile <name> add file:<本包路径>
```

语序红线：`plugin` 是子命令、**必须放在最前**。`--profile` 在前是启动语法，`plugin add ...` 会被当 app 参数透传——表现为"挂起"，profile 零改动。

### 版本兼容检查与豁免

安装前 dsh/clh 会按 `engines.dsh`/`engines.clh` 与 `peerDependencies` 对**当前运行时自报版本**做检查（报错里引用的可能是 installer 元数据版本，以 `allow-version` 回显的版本为准）。被拒时按提示授精确版本豁免再重试：

```bash
dsh plugin --profile <profile> allow-version <包名>@<版本> --dsh-version <运行时版本> --accept-risk
```

豁免按 `包@版本 + 运行时版本` 记进 profile 的 `compatibility.json`，插件升版或 harness 升级后需重授。已实测：Desktop 0.2.2-rc.1 装 `@cinlan/knowledge-sync@0.1.0` 需豁免一次（豁免按 包@版本+运行时版本 键控，改包名等于新豁免）。

### file: 与 link:

- `file:` 装时拷贝——改插件源码后要 `npm run build` + `remove` + `add` 重装才生效。
- `link:` 符号链接——源码即改即生效（重新构建后），profile 记录绝对路径；跨机器/换路径会断。

## macOS 兼容说明（已实测：Apple Silicon，0.2.2-rc.1）

插件本体双系统通用（同一份代码，无平台分支），已验证的差异与适配如下，详见 `CLH-MAC-PORT.md`：

### 安装/验收差异
- CLI 无 `.cmd` 后缀：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`；自带 node/pnpm 在 `Resources/runtime/primary-runtime/dependencies/`（node bin 在 `node/bin/node`，pnpm 入口 `pnpm/bin/pnpm.cjs`，不在 PATH 上，脚本里用绝对路径调）。
- e2e demo（`demo/e2e-demo.mjs`）自动适配：优先找 fork 源码树 `vendor/`（Windows 开发机布局），不存在时回退 `CLH_MAC_VENDOR` 环境变量指定的提取目录（或默认 `../clh-mac-vendor`）；symlink 类型按平台取 `junction`（win32）/ `dir`（其余）。
- Mac 上没有 fork 源码树时，运行时包可从官方安装版 `app.asar` 提取（cordis / schemastery / dsh-tools / loader / include / cosmokit 等），提取后需补齐 `cordis-plugin-include` 的 `js-yaml` 依赖。

### 已修复的双端兼容 bug（合入后 Windows 同样受益）
- **cordis 4.1 `volatile()` 配置分组**：schema 校验后返回 frozen 引用（`.get()` 才是值），旧版 cordis 返回普通对象。`clh-knowledge-sync` 的 `resolveNodeConfig` 已加 `unwrapConfig`（`@deepseek-ai/cosmokit` 的 `isVolatile` 递归解包），旧版下 no-op，双运行时兼容。

### 默认目录跟随 harness（双系统通用）
`clh-knowledge-sync` 的 `sync.memoryDir` / `skillRoots` **未显式配置时自动派生**（`harnessDefaultSyncRoot()`）：
1. `DSH_PROFILE_DIR`（harness 运行时注入的当前 profile 目录）→ `<profile>/clh-knowledge-sync`
2. 否则 `<DSH_HOME>/profiles/<DSH_PROFILE>/clh-knowledge-sync`
3. 兜底 `~/.dsh/profiles/default/clh-knowledge-sync`

注入方是 `@deepseek-ai/dsh-shell-env`（Windows/Mac 同一份代码，无平台分支；Mac 实证 `DSH_HOME`/`DSH_PROFILE`/`DSH_PROFILE_DIR` 三者在插件进程 env 齐备）。同一台电脑装多套 harness / 多 profile 时各实例本地记忆天然隔离；显式配置（Settings UI / 补丁）始终优先于派生默认。`sync.memoryDir` schema 已从 required 改为可选——零配置即可用。

### macOS 实测记录
- `clh-cli-agents` e2e 31/31 PASS；`clh-knowledge-sync` e2e 18/18 PASS。
- CLI agent 配置里 Windows 需注意 `.cmd/.bat` 包装不可 spawn（`clh-cli-agents` 会显式拒绝并提示）；macOS 直接给可执行文件绝对路径即可。

## 装上 ≠ 可用

- patch 行默认带 schema 校验：缺配置时该行启动即报 `invalid-config` 停在 FAILED（不拖垮应用）。配置写在目标 profile 的 `cordis.patch.yml`（用户层，后于所有 bundle 层应用）。
- **profile 的 `cordis.patch.yml` / `package.json` 是 app 托管文档**：运行中的 app 会把内存版行列表序列化回文件（改设置、装插件、退出时都可能触发）。**手改必须等 app 完全退出后**，否则下次写回被旧内存刷回原样——给已装 bundle 改包名/条目 id 同理：退出 app → 改 patch 行 id/name → 再启动。
- 无 HMR 的 profile（desktop）新 bundle 要重启才挂载；有 HMR 的（web）在线重组。

## Settings UI（可选）

插件想给用户提供配置页（而不是让人手改 YAML），走宿主 settings 机制，不引入私有运行时：

- **包声明**：`package.json` 加 `dsh.client: { platform: "web", inject: [<服务提供方包名>] }`，`exports["./client"]` 指向客户端入口文件，`files` 收录它。宿主 client-modules 扫描 Loader 行里的 `dsh.client` 包，把该文件按 `/plugins/<pkg>/client.js` 发给浏览器，compose 成 cordis 插件跑 `apply(ctx)`。
- **入口形态**：`window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ...return module.exports } })`——手写即可（不经 tsdown）；`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`dsh-client-ui-*`、`dsh-client-store` 都在模块表 seed 里，`require()` 直接用。**只 require seed 清单内的模块名**，跨包取值一律走 cordis 服务。
- **配置读写**：schema 里要暴露的分组标 `.volatile()`（host `settings` 服务才会给该 entry 开 namespace 且免 remount 生效），令牌类标 `.role('secret')`（describe 脱敏，UI 只写不读）。页面用 `ctx.configForms.get('<entry-id>')` 读镜像值、`mutate(ops)` 写回——持久化进 profile `cordis.patch.yml` override 行，等价手改 YAML。
- **热更新**：volatile 字段保存后免 remount，服务需在 `ctx.on('internal/update', (cfg, next) => { ...; return next() })` 里自行重建运行时（停旧对象→重建→恢复循环），否则"保存成功但运行仍旧值"。
- **挂页面**：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, locale, inject }, Component))`；文案走 `ctx.locale.register/bind`（en/zh 至少两份）；样式注入 `<style data-plugin-css="<包名>">`，优先复用宿主 `--dsw-alias-*` 变量，不造第二套色板。rc.1 导航就是 `entries('settings.section')` 的 `{id,order,label}` 平铺列表，不需要分组元数据；fork alpha.2 有 `settingsMetadata`（registerSection/registerItems 做分组/搜索），但**它不在双运行时共有服务集里，双兼容插件别碰**。页面拿不到命名空间时显示 `unavailable` 占位——通常是条目未激活（config 校验失败/行 id 不匹配），不是页面 bug。
- **实测差异（Desktop 0.2.2-rc.1 vs fork alpha.2）**：`settingsMetadata` 服务在 rc.1 不存在，且动态插件 ctx 对**未 inject 的服务访问直接 `rejectGuard` 抛错**——没有"读到 undefined"的防御式写法，只能在 inject 里声明两套运行时都有的服务、其余一律不碰；进 inject 门禁的必须是共有服务（`slots`/`locale`/`configForms`），否则 entry 永远 pending 拖垮 web boot。`slots.inject` 的回调**别用 `function*()`**——rc.1 不迭代生成器、函数体被当返回值丢弃，注册静默丢失（页面不出现）。统一写 `() => disposer`（多个注册就 `() => () => disposers.forEach(d => d())`），两套运行时通吃。
- inject 依赖包（`dsh.client.inject`）是**包名**：`@deepseek-ai/dsh-client-locale`（locale 服务）、`@deepseek-ai/dsh-client-ui-settings`（configForms）等；`export const inject` 则是**服务名**：`['slots','locale','configForms']`——两处别混，且只放两套运行时都存在的名字。
- 参考实现：`cinlan-knowledge-sync/client.js`。

## 新插件验收标准

- 两套 harness 各自 `plugin add` → 行挂载 → `remove` 全走通（README 记各侧运行时版本与所需豁免）。
- demo/e2e 用真实 cordis 加载，断言全过；README 如实区分「已验证 / 未验证」。
- 文本文件一律 **LF 换行**（`*.cmd` 例外用 CRLF）。
