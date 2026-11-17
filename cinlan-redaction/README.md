# @cinlan/redaction

deepseek-harness / cinlan-harness 的**出站脱敏**插件：挂在 `llm/stream` waterfall 上，把发给模型供应商的请求里的敏感值（API key、密码、邮箱、证件号…）替换成稳定占位符（`{{API_KEY_a1b2c3d4}}`），供应商回复里出现占位符时再换回原值。占位符↔原值映射只存在于本机进程内存 + 持久化 HMAC key，敏感值本身永不出境、永不落盘。

> 包名 `@cinlan/redaction`（对齐 `@cinlan/knowledge-*` 线，不带 `clh-` 前缀）——**双运行时兼容是一等约束**：同一份包在官方 deepseek-harness（Desktop 安装版）与本仓库 cinlan-harness 源码树上都要能 `plugin add` 挂载运行。

设计蓝本是 [yetone/magpie](https://github.com/yetone/magpie) 的 Settings → Privacy → Masking（完整拆解见 `apps/cinlan-harness/docs/dev/安全研发/magpie-脱敏机制分析与dsh接入可行性.md`），机制对齐、实现全部按 dsh 插件环境重写。

## 工作原理

```
agent loop
  → llm/stream waterfall（本插件 listener）
      出站: structuredClone(options) → 规则引擎扫描 messages/tools 文本
            → 命中值 → HMAC 占位符替换 → next(masked)
            → Record 记录（不含明文）
      入站: 包装 chunk 流 → text/reasoning/tool-call delta 还原占位符
            → restore 计数回写 Record
  → provider adapter → 供应商
```

三个关键性质（全部继承自 magpie，逐条有源码依据）：

1. **同值同占位符**：`HMAC-SHA256(kind + "\0" + value)` 前 8 字节 base32。同一密钥跨 turn、跨会话稳定——供应商 prompt cache 不失效、模型上下文一致。HMAC key 持久化在插件状态目录，重启不变。
2. **fail-closed**：配置要求脱敏但引擎抛错时，请求被拒绝（LlmError），**不静默放行未脱敏内容**。
3. **只改出站副本**：`llm/stream` 的 LOOP 请求是 deep-frozen 的（session log reconstructability 契约），插件克隆副本改写后传 `next()`，原件与 session log 永远是明文原文——审计和 replay 不受影响。

## 识别引擎（MVP：规则 + 词表，无本地模型）

| 通道 | 覆盖 | 来源 |
|---|---|---|
| 内置规则 | API key（sk-/ghp_/AKIA/xoxb/hf_/npm_/pypi-…）、私钥块、JWT、URL 内嵌密码、`password =`/`API_KEY:` 字段赋值、Authorization/Cookie 头、CJK「密码：/密钥为」、EMAIL、中国身份证、手机号、银行卡（luhn） | magpie `internal/redact/redact.go` 规则表移植（JS RegExp 重写） |
| 自定义词 | 项目代号、内部主机名、客户名 | config `words` |
| 自定义规则 | prefix（如网关 key 前缀）或 regex | config `rules` |
| 允许名单 | 整值放行（任何通道命中都不脱敏） | config `allow` |

本地 NER 模型（magpie 的 AstrLink Guard / Privacy Filter）不在本插件范围——树外插件不引入 onnxruntime 原生依赖。后续若 dsh 主树做 `packages/llm/redaction/`（分析文档 §8.4），本插件引擎可整体让位。

## 配置

插件配置（profile 的 `cordis.patch.yml` override，或 Settings UI 配置页——见下）：

```jsonc
{
  "secrets": true,          // 密钥类：API key、私钥、token、密码
  "personal": true,         // 个人信息：邮箱、电话、证件、银行卡
  "kinds": {                // personal 细分开关（缺省全 true）
    "EMAIL": true, "PHONE": true, "ID_CARD": true, "BANK_CARD": true
  },
  "words": ["内部代号A", "customer-xyz"],   // 你的词
  "rules": [
    { "kind": "GATEWAY_KEY", "prefix": "gw_" },          // 前缀匹配
    { "kind": "TENANT_TOKEN", "regex": "tt_[a-f0-9]{32}" } // 或正则
  ],
  "allow": ["sk-public-demo-key"],   // 整值放行
  "actions": { "BANK_CARD": "block" }, // kind → 'warn'(照发仅记录) | 'block'(脱敏并拦截请求)
  "records": true           // 脱敏记录（详情页数据源；false 时也不记录）
}
```

默认全关（`secrets:false, personal:false`）——装上插件 = 零行为变化，显式打开才介入出站。

### 失败语义

- 引擎/正则运行时错误 → 该请求以 `REDACTION_FAILED` 拒绝（fail-closed），日志记录。
  可通过 `actions` 之外的运行时不兜底——这是有意的：脱敏失败静默放行等于没有脱敏。
- `block` 动作命中 → 请求被拦（请求里该值已换成占位符，但整个请求不发）。

## 观测（脱敏记录）

每次经过 waterfall 的模型调用产出一条 Record（内存环形缓冲，默认 1000 条，不含明文值）：

```
{ turn, provider, model, bytes,
  values: [ { placeholder, kind, by: rule|word|known, head, len, n, action } ],
  replaced, tookMs, blocked, restored }
```

Record 通过 host 侧 Remote API（`/api` 上 `redaction/*` 端点，gateway SRC 认领）暴露给浏览器，两个消费面：

1. **Settings 配置页**（是否开启 + 配置 + 预览框）：粘贴任意文本 → 实时显示脱敏结果 + 命中列表（不入占位符表，不影响后续请求），先验证规则再启用。
2. **聊天框「脱敏」tab**（轨迹旁详情页，对齐分析文档 §3.4/§8.3 与 magpie 观测页）。

## 聊天框「脱敏」详情 tab

对齐 magpie 的观测 → 脱敏详情页与分析文档 §3.4：`conversation.view` slot 注册（`order: 15`，排在轨迹 order 10 旁边），按当前 session 展示脱敏流水，方便审查每笔出站请求。

### 视图（对齐 magpie 详情页）

```
┌─ 聊天框顶部 ──────────────────────────────────────┐
│ [聊天] [轨迹] [脱敏] ← settings 开启并 records=true │
└───────────────────────────────────────────────────┘

  #42  14:32:07  deepseek-chat  126 KB
  收到 → 发现 5 个值（规则 2 · 你的词 1 · 已知 2）· 2.1s
       → 替换 12 处 → 发送 → 回复中还原 0 处

  展开后值级列表（每值一行，不显示明文）：
  Ryan Gosling  [个人信息] [规则]  messages[0].content[0].text  ×3  还原 0
  /PRNG/ZKP/ [密码]   [你的词] messages[2].content[1].text  ×1  还原 0
```

- **流程链行**：请求大小、发现值数（按 finder 分组）、替换处数、耗时、回复还原数；`block` 动作命中的请求标红「已拦截」、`warn` 值标黄「已照发」。
- **值级列表**：占位符 + hint（首字符/长度）、kind 徽标、finder 徽标、JSON path 位置、出现次数、还原计数。**永不显示明文值**。
- **筛选**：按 finder / kind / provider；**清空**当前 session 记录。

### 「settings 配置了才显示」——插件版 gating 实现

树外插件不能改 `ui-conversation` 核心的 `viewTabs()` 汇总（那是主树方案 A 的做法），改用**动态注册/注销**：client.js 读 `configForms.get('redaction')` 镜像，`secrets || personal || words.length > 0`（即脱敏实际介入）且 `records` 开启时才 `ctx.slots.register` 该 tab，配置变化时注销再注册。这正是 `cinlan-knowledge-sync` 侧边栏 `mountSidebar`/`sidebarRelease` 的现成模式（事件驱动 + dispose），双运行时已验证。

注：注销期间已激活的会话 view 偏好回落到聊天 tab（`resolveActiveView` 找不到注册 id 时的宿主默认行为），无需插件处理。

### 数据通道

host `records.ts` 的环形缓冲 → Remote API（`redaction/list` 按 sessionId 过滤 + `redaction/clear`）→ client.js 经 `ctx.connection.rpc.call('/api', 'redaction/list', ...)` 拉取（`cinlan-knowledge-sync` MemoryPanel 同款直连模式，不走 typert 目录——记录端点不给模型工具暴露是刻意的）。tab 挂载时轮询 + 会话切换时刷新；轮询间隔复用 `cinlan-knowledge-sync` 的 runtimePoll 模式（默认 1s，页面可见时才轮询）。

## Settings UI

提供 `dsh.client` 浏览器半包（`client.js`，手写 `__ModuleLoader__` 形态，同 `cinlan-knowledge-sync`）：settings.section 注册「脱敏」配置页（是否开启 + 全部配置 + 预览框），conversation.view 注册「脱敏」详情 tab。双运行时红线全部遵守：

- `slots/locale/configForms` 进 inject（两套 harness 共有）；`settingsMetadata` 不碰（rc.1 无此服务）。
- `slots.inject` 回调一律普通函数返回 disposer（rc.1 不迭代生成器）。
- 样式 `<style data-plugin-css>`，色板复用宿主 `--dsw-alias-*` 变量。

## 目录结构

```
cinlan-redaction/
├── package.json          # @cinlan/redaction + dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert: redaction 行
├── tsconfig.json
├── src/
│   ├── index.ts          # 插件入口：Config schema + llm/stream listener + 服务
│   ├── rules.ts          # 内置规则表（magpie 移植）
│   ├── engine.ts         # span 扫描/合并 + 占位符生成/还原
│   ├── store.ts          # 占位符表（HMAC key 持久化 + LRU）
│   ├── records.ts        # Record 环形缓冲
│   └── api.ts            # Remote 端点：redaction/list|clear|preview
├── client.js             # 浏览器半包：settings 配置页 + conversation.view 详情 tab
├── tests/                # 规则 golden 测试（magpie eval_cases 用例移植）
└── lib/                  # tsc 构建产物
```

## 安装

```cmd
# 官方安装版（Desktop）
"D:\CodeTools\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:<本包绝对路径>"

# 源码树（clh）
clh plugin --profile <name> add file:<本包路径>
```

装后需构建（`file:` 是拷贝语义）：`npm run build` 再 add；改源码后 remove + add 重装。

## 状态

| 项 | 状态 |
|---|---|
| 方案 | 本 README（对齐分析文档 §8 的插件化裁剪 + §3.4/§8.3 详情 tab + settings 配置页） |
| 实现 | **已完成（v0.1.0，待实机验证）**：`src/`（rules/engine/store/records/index）+ `client.js`（settings 配置页 + 脱敏详情 tab）+ `tests/`（13 项单测全绿）+ 构建产物 `lib/` |
| 验证 | `npm run typecheck` ✅ · `npm run build` ✅ · `npm test` ✅（13 pass / 0 fail）· `lib/index.js` ESM 加载冒烟 ✅ |
| 已验证依赖 | `ctx.on('llm/stream')` waterfall 在两套 harness 的先例：主树 `llm-replay`（test-support）；外部插件加载/双运行时红线：`cinlan-knowledge-sync`、`cinlan-cli-agents`（README 记录的实测结论）；动态 slot 注册/注销 gating：`cinlan-knowledge-sync` mountSidebar 模式；Remote API 直连：`cinlan-knowledge-sync` MemoryPanel `/api` 模式 |

**未验证**（实现阶段需 PoC）：外部插件 `ctx.on('llm/stream')` 在 Desktop 0.2.2-rc.1 与 fork alpha.2 的实际挂载顺序；`conversation.view` slot 在 rc.1 侧的行为（tab 注册是 fork 侧 ui-conversation 机制，rc.1 宿主需实测；应对同依赖规则——inject 只放共有服务，slot 不可用时占位不拖垮页面）。

### 实现记录（2026-11-16）

- **规则表**（`src/rules.ts`）：magpie `internal/redact/redact.go` 移植裁剪版——PRIVATE_KEY / sk- / ghp_ / AKIA / xox / hf_ / npm_ / pypi- / cfut_ / eyJ JWT / URL 密码 / `password =` 类赋值 / Authorization/Cookie 头 / CJK 密码·密钥赋值 / EMAIL / 身份证 / 手机 / 银行卡（luhn）等 25 条；谓词 `notASlug` / `secretValue` / `luhn` / `chineseID` 移植；`at` 位置谓词（URL 内 email 不误报）。magpie 的 fieldAt/emailAt/phoneAt 全套上下文谓词与 known.go（已 mask 值记忆）在 v2。
- **占位符**（`src/store.ts`）：`HMAC-SHA256(kind + "\0" + value)` 前 8 字节 base32 小写（无 padding）；HMAC key 32 字节持久化 `.dsh-redaction/placeholder-key`（0600），同值同占位符跨重启稳定；容量 200k、半量 LRU 淘汰——与 magpie 全局表语义一致。
- **引擎**（`src/engine.ts`）：span 扫描（内置规则 + 自定义 prefix/regex + words + allow 整值放行）→ 最长优先合并去重 → 占位符替换；还原支持规范形态与大小写漂移，`StreamRestorer` 带 hold 状态机（跨 chunk 占位符不截断，`flush()` 收尾）。
- **插件行**（`src/index.ts`）：`llm/stream` waterfall listener；`structuredClone` 出站副本改写（LOOP 原件 frozen 不动）；`block` 动作 fail-closed 拒发（`REDACTION_BLOCKED`）；Record 环形缓冲（1000 条，无明文）；Remote API `redaction/list|clear|preview` 走 `/api`（gateway SRC descriptor 手工冻结，同 knowledge-sync 模式）。
- **client.js**：settings.section「脱敏」配置页（总开关 / kinds 细分 / words / rules / allow / records + **预览框**：调 `redaction/preview` 实时显示替换结果与命中列表，preview 不入占位符表）；conversation.view「脱敏」tab（order 15，轨迹旁），按 config 镜像**动态注册/注销**（mountSidebar 模式 + `form.subscribe` 驱动）；双运行时红线遵守（inject 仅 `slots/locale/configForms/connection`，普通函数 disposer，不碰 settingsMetadata）。
- **测试**（`tests/rules.test.ts`，node:test 直跑 TS）：稳定占位符、私钥块、URL 密码、CJK 密码、personal/kinds/allow/自定义词规则、还原、跨 chunk hold、overlap 合并——13 项。

遗留（PoC 清单）：
1. Desktop 0.2.2-rc.1 / fork alpha.2 实机 `plugin add` 后过一次含 `sk-` key 的真实会话，确认 vendor 侧收到占位符、回复还原。
2. `conversation.view` 在 rc.1 宿主的 tab 渲染（fork 侧机制；不可用时只影响 tab 展示，不影响 host 脱敏）。
3. `tool-call-delta` 流式 JSON 参数占位符跨 delta 还原依赖 StreamRestorer hold——已单测覆盖单块场景，多 tool-call 并发流需实机确认。
4. magpie known.go（已 mask 值记忆）与 sentSpans 跨 turn 优化未做——当前每 turn 全量扫描，长会话性能待实测（12KB chunk / 增量缓存是 magpie 的解法，v2 跟进）。
