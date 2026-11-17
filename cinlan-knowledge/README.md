# cinlan-knowledge

团队 Agent 的**记忆中枢（Memory Hub）**。记忆（memory）、技能（skill），以及后续的 wiki / codegraph，统一登记为**记忆资产**：带 Owner、版本、状态、可见性、ACL、用量；按 Agent **配装（Loadout）**；新 Agent 接入即"读档"。

模型对标 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（Memory Hub）。与腾讯的关键差异：**不要求任何特定宿主**。dsh（DeepSeek Harness）、Claude Code、Codex CLI、Gemini CLI 以及任意支持 MCP 的 agent harness / CLI 用同一套客户端接入。`cinlan-knowledge-sync` 与本目录早期文档是 demo：不再作为约束，只作为教训输入（见 [docs/decisions.md](docs/decisions.md) §4）。

> 状态：设计定稿，代码未开始。本目录目前只有文档，下文命令是目标形态。

## 一张图

```
       管理面                                 运行面（各宿主的机器）
  panel（控制台 SPA） ─┐              ┌─ 宿主 ──stdio MCP──▶ ck mcp   ─┐
  ck rpc ──────────────┤              ├─ 宿主 ──会话 hook──▶ ck hook  ─┤
                       ▼              ├─ 宿主 ──远端 MCP（A0）────────┤
        ┌──────────────────────────────┴──────────────────────────────┐
        │ hub    POST /api/v1/<域>/<动作>   POST /mcp   /panel  /dl    │  User Key 认证 · 统一信封
        ├──────────────────────────────────────────────────────────────┤
        │ core   meta │ asset │ access │ loadout │ review              │
        │        search │ usage │ audit                                │
        ├──────────────────────────────────────────────────────────────┤
        │ SQLite 单文件（关系 + 版本 + FTS5）                          │
        └──────────────────────────────────────────────────────────────┘
```

一个进程、一个端口（8424）、一个数据库文件。

## 六个概念

| 概念 | 一句话 | 腾讯对应 |
| --- | --- | --- |
| User / User Key | 人与其访问密钥；key 只存摘要，可多把、可吊销 | user / user-key |
| Team | 协作与授权边界；角色 Admin / Member | team / team-member |
| Agent | 某人在某团队里的一个 Agent 实例（如 `cc-ly`），配装挂在它身上；可跨宿主复用同名 | agent |
| Asset | 记忆资产：`memory` / `skill`（`wiki` / `codegraph` 留位）；Owner + 版本 + 状态 + 可见性 | 统一记忆资产 |
| Loadout | 配装 = 固定绑定 + ACL：先按权限收窄，再按优先级与预算注入 | Agent Loadout |
| Review | 提升可见性（共享）与他人提议修改时的审批单 | 我们加的治理层 |

可见性四档（同腾讯）：`private`（仅 Owner）/ `team`（成员可读，Owner 与 Admin 管理）/ `restricted`（按 User / Role / Agent 精确授权）/ `agent`（定向配给某些 Agent）。新资产一律 `private`，共享是显式动作。

## 运行面：一套客户端，多种宿主

| 等级 | 做法 | 适用 |
| --- | --- | --- |
| **A1**（默认） | 宿主配置里一条 stdio MCP 条目 + 一条会话开始 hook，都指向 `ck` | 能装 Node 的机器 |
| A0 | 宿主直连 hub 的 `/mcp` | 装不了 `ck`；零安装 |
| A2 / A3（P3 可选） | 宿主原生插件 / LLM 流量代理 | 既无 MCP 也无 hook 的宿主 |

`ck` 提供三样东西：stdio MCP server（五个工具）、会话开始 hook（打印宿主格式的读档 JSON）、skill 物化。读档文本由 hub 的 `loadout/resolve` 生成，所有通道拿到的是同一份字符与 digest。宿主差异（配置格式、预算、送达方式、skill 目录）是 `agents/<host>/host.json` 里的数据，不是代码分支。

## 与 demo 的根本区别

| demo（cinlan-knowledge-sync / 早期文档） | 现方案 |
| --- | --- |
| 节点 token + scope 通配授权 | User Key + Team 成员关系 + 资产可见性 / ACL |
| 本地 markdown 与 hub 双向文件同步（seq / tombstone / 冲突副本） | hub 是唯一事实源；客户端只取配装结果，本地仅缓存兜底 |
| 每次 push 都要 admin 审批 | 默认 private 免审；**提升可见性**才过审 |
| 拉到 `shared/` 目录没人消费 | 配装：固定绑定注入 + 按需检索工具 + skill 物化 |
| JSON 文件存储 | SQLite 单文件 |
| 单 adminToken | System Admin / Team Admin / Member / Owner |
| 只服务 dsh 一种宿主 | MCP + `ck`，宿主无关 |

## 目录结构（目标）

```
cinlan-knowledge/
  packages/
    sdk/     @cinlan/knowledge-sdk    契约类型 + 错误枚举 + fetch client（零依赖）
    core/    @cinlan/knowledge-core   领域内核（零 HTTP）：meta / asset / access / loadout / review / search / usage / audit
    mcp/     @cinlan/knowledge-mcp    MCP 面：五个工具定义 + instructions 生成 + 固定引导语（唯一 import MCP SDK 的包）
    hub/     @cinlan/knowledge-hub    HTTP 壳：动作注册表、认证、信封、/mcp、/dl、托管 panel、CLI（serve / bootstrap / backup）
    cli/     @cinlan/knowledge-cli    ck：login / setup / mcp / hook / skills / import / doctor / rpc
    panel/   @cinlan/knowledge-panel  控制台 SPA
  agents/
    dsh/          host.json + 配置模板 + 接入手册
    claude-code/  同上
    codex/        同上（P2）
    gemini-cli/   同上（P2）
    generic-mcp/  MCP 宿主通用接入说明
  deploy/    Dockerfile / systemd unit / 配置样例
  docs/
```

依赖方向单向：`panel / ck / MCP 宿主 → hub → core → SQLite`；`mcp` 只依赖 `sdk` 与 MCP SDK；`agents/<host>/` 只有声明与模板。

## 分期

| 期 | 交付 | 验收门 |
| --- | --- | --- |
| P0 | 骨架、契约、6 个技术 spike（S1–S6） | 构建与测试通过；spike 结论写回 decisions.md |
| P1 | 后端闭环（meta / asset / access / loadout / review / search）+ `/mcp` + `ck` + dsh 与 Claude Code 两个参考宿主 | "读档" e2e 全绿；权限矩阵全绿；两个宿主实机读档成功 |
| P2 | 控制台、用量、审计、`ck import`、Codex 与 Gemini CLI 接入 | 六个模块可用；四个宿主实机读档成功 |
| P3 | 自动沉淀（L0 → 草稿）、可选原生插件 / Proxy / 向量 | 草稿闭环；覆盖更多宿主 |
| P4 | 知识工坊（wiki / codegraph） | 另立规格 |

每期的任务顺序与验收命令见 [docs/sop.md](docs/sop.md)。

## 文档

- [docs/blueprint.md](docs/blueprint.md) —— 落地蓝图：不变量、每层定案与红线、PR 自查（写代码以此为准）
- [docs/architecture.md](docs/architecture.md) —— 组件、主流程、运行面通道、安全要点、部署形态
- [docs/hosts.md](docs/hosts.md) —— 宿主矩阵、接入等级 A0–A3、各宿主做法、新增宿主的六个问题、本机资产导入
- [docs/loadout.md](docs/loadout.md) —— 配装解析算法、三种投递方式与预算、`ck` 运行时与缓存、工具规范、skill 物化
- [docs/data-model.md](docs/data-model.md) —— 表结构、可见性与权限矩阵、状态机、版本、审批策略
- [docs/api.md](docs/api.md) —— API 约定、MCP 端点、错误枚举、动作目录、关键请求示例
- [docs/install.md](docs/install.md) —— hub 部署、`ck` 安装、各宿主接入、验收与排错
- [docs/sop.md](docs/sop.md) —— 实现 SOP（分期任务 + 验收门）与运营 SOP
- [docs/decisions.md](docs/decisions.md) —— 决策记录、取自腾讯的清单、demo 教训、已定与待定项、新依赖、未验证项
- [docs/comparison.md](docs/comparison.md) —— 与腾讯 / MCP 记忆生态的对比
