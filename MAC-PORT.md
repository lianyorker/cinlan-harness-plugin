# clh 插件 macOS（Apple Silicon）移植与适配记录

日期：2026-11-09　环境：macOS（DeepSeek Harness Desktop 安装版 0.2.2-rc.1，自带 node 24.21.0 / pnpm 11.28.5）

## 结论

| 插件 | 安装 | e2e 验收 |
|---|---|---|
| `@cinlan/clh-cli-agents` | ✅ desktop profile | ✅ 31/31 PASS |
| `@cinlan/clh-knowledge-sync` | ✅ desktop profile（修复后重装） | ✅ 18/18 PASS |

安装命令（Mac 上 CLI 是 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，无 .cmd 后缀）：

```bash
dsh plugin --profile desktop add "file:<仓库绝对路径>/clh-knowledge-sync"
dsh plugin --profile desktop add "file:<仓库绝对路径>/clh-cli-agents"
```

**重启 DeepSeek Harness 桌面端后生效**（desktop profile 无 HMR）。

## 跟踪出的 Windows → Mac 差异清单

### 1. e2e demo 依赖 fork 源码树（阻断级）
两个 `demo/e2e-demo.mjs` 硬编码 `../../cinlan-harness`（fork 源码树）取 `vendor/cordis`、`vendor/schemastery`、`packages/core/tools` —— Mac 上没有这棵树。
**适配**：从官方安装版 `app.asar` 提取运行时包（cordis 4.1.0 / schemastery 3.19.0 / dsh-tools / loader / include / cosmokit 等）到独立目录；demo 改为 `existsSync` 探测 fork 树，缺失时回退 `CLH_MAC_VENDOR` 环境变量或默认 `../clh-mac-vendor`。Windows 行为不变。

### 2. `fsp.symlink(..., 'junction')`（阻断级，Windows 专属）
Node 在非 Windows 上不支持 'junction' 类型 symlink。
**适配**：`process.platform === 'win32' ? 'junction' : 'dir'`。

### 3. cordis 4.1 `volatile()` 配置分组语义（功能性 bug，最重要）
`clh-knowledge-sync` 的全部配置分组标了 `.volatile()`。cordis 4.1.0 的 schemastery 3.19 校验后，volatile 分组返回 **frozen 引用对象**（`.get()` 才是真实值），旧版返回普通对象。插件 `resolveNodeConfig` 直接读字段拿到 undefined → 构造器抛 invalid-config → 行 FAILED。
**修复**：`lib/config.js` + `src/config.ts` 增加 `unwrapConfig`（用 `@deepseek-ai/cosmokit` 的 `isVolatile` 递归解包），对旧版 cordis 是 no-op，双运行时兼容。

### 4. 提取运行时包缺依赖（环境级）
asar 里 `cordis-plugin-include` 缺 `js-yaml`、`cordis` 内层缺 `cosmokit` 等：已用 pnpm 补装/补拷。

### 5. 无需改动的部分（已确认跨平台）
- `clh-cli-agents` 的 PATH 解析：`.cmd/.bat` 拒绝逻辑只在 win32 分支，Mac 走正常 Unix PATH 解析。
- `clh-knowledge-sync` 默认目录 `~/.dsh/clh-knowledge-sync/`：Unix 布局天然兼容。
- Settings UI 的目录选择器：走宿主 `ctx.remote.directoryPicker`，平台无关（个别 placeholder 是 Windows 风格路径，仅展示问题）。
- 文本文件全部 LF，`bin/` 脚本 shebang 正常。

### 6. 沙盒/权限（本会话特有，与插件无关）
`dsh plugin add` 要写 `~/.dsh/profiles/desktop`，会话沙盒默认拒绝，需完整磁盘访问。

## 修改的文件

- `clh-cli-agents/demo/e2e-demo.mjs`：HARNESS_DIR 回退 + junction→dir + vendor 路径回退
- `clh-knowledge-sync/demo/e2e-demo.mjs`：同上
- `clh-knowledge-sync/lib/config.js` + `src/config.ts`：unwrapConfig（volatile 解包）

## 复跑验收（Mac）

```bash
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
export CLH_MAC_VENDOR=<提取的运行时包目录>
cd clh-cli-agents && node demo/e2e-demo.mjs      # 31/31
cd ../clh-knowledge-sync && node demo/e2e-demo.mjs  # 18/18
```

## 增补：目录跟随 harness（双系统通用改造）

### 需求
默认同步目录不再写死 `~/.dsh/deepseek-sync`（Windows 为 `%USERPROFILE%\.dsh\...`），改为**跟随 harness 运行时注入的目录环境变量**派生——同一台电脑装多套 harness / 多 profile 时各实例本地记忆天然隔离，不怕用户篡改默认目录。

### 环境变量注入规范审查（Windows / Mac 差异化确认）
- 注入方：`@deepseek-ai/dsh-shell-env`（所有 dsh surface 共用，Windows/Mac **同一份代码**，无 win32 分支）：
  - `DSH_HOME`：harness 根目录（Mac `/Users/x/.dsh`，Windows `C:\Users\x\.dsh`）
  - `DSH_PROFILE`：当前 profile 名
  - `DSH_PROFILE_DIR`：当前 profile 完整目录（`path.join` 处理分隔符，双端自动正确）
- 注入链：`profile-boot` → `DSH_LAUNCH_ENVIRONMENT_KEY` 提供方 → 插件运行进程 env（已实证：macOS 插件进程 env 中三者齐备；Windows 由同一份 launcher 代码注入，仅值随平台不同）。

### 实现（`clh-knowledge-sync` config）
`resolveNodeConfig` 新增 `harnessDefaultSyncRoot()`：
1. `DSH_PROFILE_DIR` 存在 → `<profile>/clh-knowledge-sync`
2. 否则 `<DSH_HOME>/profiles/<DSH_PROFILE>` → `clh-knowledge-sync`
3. 兜底 `~/.dsh/profiles/default`
优先级：**用户显式配置（Settings UI / 补丁）> 环境派生默认**；`sync.memoryDir` 从 required 改为可选；`skillRoots` 未配置时默认 `<根>/skills`。Windows/Mac 同一份代码，无平台分支。

### 回归
- 派生默认：`DSH_PROFILE_DIR=/tmp/fake-profile-dir` → memoryDir/skillRoots 正确派生 ✅
- 显式优先：显式路径不被覆盖 ✅
- e2e：18/18 PASS（显式路径模式）✅

## 增补 2：热更新对齐（link: 安装 + 增量重建）

- **link: 安装**：本地开发用 `plugin add "link:<路径>"`，profile 符号链接源码目录，改代码无需 remove+add（UI 改动经 HMR 热换入，服务改动重启加载即最新）。
- **增量重建**：`resolveNodeConfig` 新增 `diffResolvedConfig(prev,next)`，`applyUpdate` 按 diff 分域——`client`(hub 连接/node) / `local`(目录/scope) / `timer`(auto/interval) / `logger`。仅换变化域，HTTP 连接与同步状态保留；无实质变化时零重建。
- 回归：diff 四场景断言通过，e2e 18/18 PASS。
