# clh-knowledge-sync 安装教程（新机器一次到位）

适用：DeepSeek Harness / Cinlan Harness 的任一 profile（Desktop 与 CLI 同流程）。本教程按 2026-11-09 两台 Windows 机器实测整理，把每一步会踩的坑直接写进对应步骤——照做即可一次装成。

## 前置

- **hub 已在跑**，且 hub `auth.nodeTokens` 里登记了本节点要用的 token（没有就先起 hub，见 README「启动 hub」）。
- 知道目标 **profile 名**（本教程用 `desktop`；别的 profile 替换 `--profile` 值与路径即可）。

## 0. 备齐三样东西

- **节点 token**：hub `auth.nodeTokens` 里给本节点登记的值。
- **数据目录（统一约定）**：`memoryDir`/`skillRoots` 用 `%USERPROFILE%\.dsh\clh-knowledge-sync\memory` 和 `%USERPROFILE%\.dsh\clh-knowledge-sync\skills`——**规范：自家插件数据目录一律 `clh-` 前缀**，所有机器同一约定，目录名不要自由发挥（实测出现过 `knowledge-sync`、`deepseek-sync` 各起各的，跨机排障时对不上号）。必须绝对路径。
- **dsh.cmd 路径**：`<安装目录>\resources\runtime\cli\bin\dsh.cmd`——不在 PATH，必须全路径调用；`plugin` 必须是第一个子命令。

## 1. 拿源码：整仓 clone 是正常的

```powershell
git clone https://github.com/lianyorker/cinlan-harness-plugin.git "$env:USERPROFILE\.dsh\plugins\cinlan-harness-plugin"
```

仓库是 monorepo（根目录**没有** package.json），clone 只能整仓。但注意两条边界：

- `plugin add` 的路径必须指到**子目录** `clh-knowledge-sync`——指仓库根会 `not-a-package` 失败；
- 别直接 `plugin add <git URL>`——pnpm 会把整仓当单个依赖拉取，同样不是可安装包。

clone 放哪都行，它**不会被运行时扫描**——解析只认 dsh 安装目录 + profile `node_modules` + `$DSH_HOME/profiles/node_modules` 回退，必须走下一步的 `plugin add` 才真正安装。

## 2. 构建？不用

`lib/` 随 `src/` 一起入库（同一提交），clone 下来的 `lib/` 就是当前构建产物。

`npm run build` 在没有相邻 `cinlan-harness` 源码的机器上必然失败（tsconfig 的类型路径映射找不到 `@deepseek-ai/*`）——**这不是安装障碍，跳过即可**。只有改了 `src/` 才需要构建：在有 cinlan-harness 源码的机器上 `npm install && npm run build`，把产物提交回仓库。

## 3. 安装到 profile

```powershell
& "<安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:$env:USERPROFILE/.dsh/plugins/cinlan-harness-plugin/clh-knowledge-sync"
```

- 报 `incompatible-version` → 按报错里给的运行时版本授精确豁免后重跑 add：

  ```powershell
  & "…\dsh.cmd" plugin --profile desktop allow-version '@cinlan/clh-knowledge-sync@<插件版本>' --dsh-version <运行时版本> --accept-risk
  ```

- 报 `ERR_PNPM_UNEXPECTED_STORE` → 见 3.1。
- 之前装过想刷新 → 先 `plugin remove` 再 `add`（`file:` 是**拷贝**，不重装跑的还是旧副本）。

**成功标志**：`profiles\desktop\package.json` 出现 `"@cinlan/clh-knowledge-sync": "file:..."`，且 `dsh.profile.bundles` 追加了 `"@cinlan/clh-knowledge-sync"`。

### 3.1 ERR_PNPM_UNEXPECTED_STORE

profile 现有 `node_modules` 链接指向一个 pnpm store，本次调用解析到另一个（CLI 环境缺 `LOCALAPPDATA` 时 pnpm 回落到 `~/.pnpm-store`）。不是装坏了，两法任选：

**首选——对齐 store，不动任何文件**（与 add 同一个 PowerShell 窗口）：

```powershell
$env:LOCALAPPDATA="$env:USERPROFILE\AppData\Local"
$env:npm_config_store_dir="$env:USERPROFILE\AppData\Local\pnpm\store\v11"
& "…\dsh.cmd" plugin --profile desktop add "file:..."
```

pnpm 认的变量名是 `npm_config_store_dir`（`PNPM_STORE_*` 无效）。dsh CLI 分支继承 `process.env`，会传进 pnpm。

**仍失败——重建链接目录**（删的是 junction 链接，不是数据）：

```cmd
cmd /c rmdir /s /q "C:\Users\<user>\.dsh\profiles\desktop\node_modules"
del "C:\Users\<user>\.dsh\profiles\desktop\pnpm-lock.yaml"
```

然后**不设** store env 重跑 add——pnpm 会用新 store 重新硬链/下载依赖。

**禁令**：

- **不要用 `Remove-Item -Recurse` 删 node_modules**——PowerShell 5.1 会顺 junction 删掉 store 里的真实数据；用 `cmd /c rmdir`。
- 不改全局 pnpm config。

## 4. 写配置（写进同一个 profile！）

编辑 `profiles\desktop\cordis.patch.yml`，给 `- id: clh-knowledge-sync` 的 override 行补完整 config（bundle 自带的 `cordis.patch.yml` 已插主行 + tools 行，override 只需给 config）：

```yaml
- id: clh-knowledge-sync
  config:
    node:
      id: <节点 id，如 desktop-机器名>
      token: '<hub 登记的 token>'
    hub:
      activeProfile: intranet
      profiles:
        intranet:
          protocol: http
          host: <hub 地址>
          port: 47610
          timeoutMs: 8000
    sync:
      auto: true
      intervalSec: 300
      syncOnStart: true
      memoryDir: 'C:\Users\<user>\.dsh\clh-knowledge-sync\memory'      # ← 统一约定 clh- 前缀，勿改
      skillRoots:
        - 'C:\Users\<user>\.dsh\clh-knowledge-sync\skills'             # ← 统一约定 clh- 前缀，勿改
    oneshot:
      enabled: false
      commands: []
    log:
      level: info
```

要点：

- **override 必须写进会话实际用的那个 profile**——bundle 装进 A、override 写进 B，A 的主行缺 config 启动即 `invalid-config` FAILED（而 tools 行照样注册，所以工具能出现、调用才报错）。
- `memoryDir`/`skillRoots` 必须绝对路径（相对路径会 resolve 到 harness 进程 cwd，不是 profile 目录）。
- **token 直接写字面值**（推荐、确定性）。`!!js process.env.X` 只在 config 内求值、取的是 **app 启动那一刻的进程环境**：`setx` 对运行中的进程无效，Electron 应用内重启/开机自启/远程会话继承的都是旧 env——实测同一台机器「有时挂上有时挂不上」的根因就是它。除 CLI 且 env 可控外不要使用。

## 5. 生效与验证

**运行中的会话永远用旧组合**——改完必须【托盘右键退出 Desktop → 重新启动 → 开新会话】再验证，旧会话重试一万次也一样。

新会话里验证（任一即可）：

- 调用 `dss_status` / `memory_push`：通了 = 服务已挂；
- Settings → 插件页：`clh-knowledge-sync` 行状态 OK（FAILED 会写明原因）；
- 磁盘：`<memoryDir>\.clh-knowledge-sync\logs\` 有新日志、`sync-state.json` 有写入。

## 错误速查表

| 现象 | 原因 | 修法 |
|---|---|---|
| `not-a-package` | add 指到仓库根 / 直接给 git URL | 路径指到子目录 `clh-knowledge-sync` |
| `incompatible-version` | peer 版本检查 | `allow-version` 精确豁免后重跑 add |
| `ERR_PNPM_UNEXPECTED_STORE` | pnpm store 目录不一致 | 见 3.1 |
| `clh-knowledge-sync 主插件行未挂载（ctx.clhKnowledgeSync 不可用）` | tools 行在但主行 FAILED：config 缺失、`!!js` env 取不到、override 写错 profile | Settings 插件页看该 FAILED 原文；按第 4 步逐条核对 |
| 工具能调用但同步不动 / 配置改了不生效 | app 没重启、用的旧会话 | 托盘退出 → 重启 → 新会话 |
| 改了 src 代码不生效 | `file:` 安装是拷贝 | `plugin remove` + `plugin add` 重装 |
| `npm run build` 报找不到 `@deepseek-ai/*` | 本机没有相邻 cinlan-harness 源码 | 不用构建，`lib/` 已入库（见第 2 步） |
| 会话里 `run_code` 报 `SetNamedSecurityInfoW failed (Win32 5)` | 宿主沙箱给工作目录授 ACL 被拒，与本插件无关 | 换普通用户目录下的工作区 |
