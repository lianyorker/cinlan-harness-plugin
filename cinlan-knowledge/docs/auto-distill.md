# 自动沉淀规格草案（O-7，sop.md P3 第一块）

状态：规格起草完成（2026-11-16），待 Yorker 拍 §4 的通道与触发两项后开工。本文是"先补规格过拍板"的交付物，不是实现。

## 0. 目标与验收（sop.md 241 原文）

> `session/report` → 抽取 → 私有草稿 → panel `/inbox`；验收：草稿他人不可见，采纳后才可检索。

与 `knowledge_save`（会话内显式沉淀，mcp/src/tools.ts:128）互补：自动沉淀兜的是**会话结束时没人喊"记下来"**的那部分。

## 1. 结论先行

- **两条验收语义大半是白捡的**：`draft` 状态在现有机器里就是"仅 owner 可见 + 不进检索"——`ACCESSIBLE_SQL` 各分支排除 draft（access.ts:119-132），`canRead` 对 draft 直接 false（access.ts:61），`searchAssets` 只收 `active`/`deprecated`（search.ts:131-147 之外的过滤器）。「采纳后才可检索」= 状态机里现成的 `draft → active`（`activate`，asset.ts:905）。规格的核心工作在**抽取通道与上报入口**，不在权限。
- 唯一的 core 改点很小：`createAsset` 硬编码 `status: "active"`（asset.ts:391），需要加 `status: "draft"` 入参（默认 active 不变，零回归）。
- 抽取通道是 O-7 本体，选项与 O-9 embedding 通道**同一道题**（vector-search.md §4.3 的 A/B/C），建议一次拍掉两项。

## 2. 现状事实（2026-11-16 核实）

| 事实 | 位置 |
|---|---|
| `session/report` 动作不存在，hub 侧零 LLM 调用（架构原则"不代理 LLM 流量"） | actions.ts 全文、architecture.md:9 |
| 状态机支持 `draft → active`（activate）、`draft → archived`（archive） | asset.ts:905, 907 |
| draft 对他人不可见（canRead false + SQL 谓词全排除） | access.ts:61, 119-132 |
| 检索排除 draft（只收 active/deprecated） | search.ts 过滤器 |
| `asset/list` 已支持 `status` 筛选（panel Usage 冷清单在用 `status: "active"`） | actions.ts:474 → core listAssets |
| `createAsset` 硬编码 active，无 draft 入口 | asset.ts:391 |
| MCP 会话内工具：search / open / save / share / status | mcp/src/tools.ts:71-204 |
| panel 现无 /inbox 页（panel-design.md 亦无收件箱概念，纯新页） | panel/src/pages、panel-design.md |

## 3. 流程草图（拍板后按此落）

```
宿主机（ck 侧）                    hub                          panel /inbox
──────────────                ─────────                    ─────────────
会话结束触发（§4.2） ──载荷──▶ session/report
                              通道 A'：载荷已是结构化候选
                                  → 逐条 asset/create(status=draft, private)
                              通道 B'：载荷是原文/摘要
                                  → hub 调模型抽 N 条候选 → 同上
                                  （草稿落库；失败记 audit，不重试）
                                                  owner 登录 ──▶ asset/list(status=draft, mine)
                                                                每条：编辑（draft 版本）/
                                                                采纳（activate，可同时改可见性 →
                                                                  team 走既有审批流）/
                                                                丢弃（archive）
```

采纳后的检索可见性完全复用现有 `activate` + `set-visibility` 语义；`activate` 与 `set-visibility team` 的先后组合由一个复合动作封装（`inbox/adopt`），避免两步中间态。

## 4. 待拍板清单（Yorker，§4.1 与 O-9 联动拍）

### 4.1 抽取通道（O-7 本体）

| 选项 | 流程 | 说明 |
|---|---|---|
| **A'. 客户端抽取**（推荐起点） | ck 在宿主机调模型出候选 → `session/report` 直接送结构化清单 | 不破"不代理 LLM 流量"；复用 codex 实机验收同款网关思路（magpie）；缺点：每台机器要配模型 |
| B'. hub 通道 | `session/report` 送原文 → hub 配 `distill: {url, key, model}` 调模型 | 回填即时、宿主机零配置；但 hub 从"不碰 LLM"变"碰 LLM"，O-9 embedding 若也走 hub 则一并破例，要显式接受 |
| C'. 手动触发 | `ck distill --session <file>`（CLI 粘会话记录） | 最小可行，可作 A'/B' 落地前的过渡 |

### 4.2 上报触发时机

| 选项 | 说明 |
|---|---|
| hook 事件 | claude-code 有 `SessionEnd` 类 hook；gemini / codex / hermes 的事件面参差（hermes 是 `pre_llm_call`，没有会话尾事件）——**无法全宿主统一**，只能按 host.json 声明逐宿主开 |
| 模型自报 | 新 MCP 工具 `knowledge_session_report`，模型在会话尾声自己调用（与 knowledge_save 同机制，宿主无关） |
| 手动 | C' 的 CLI 入口，保底 |

建议组合：**模型自报（宿主无关）为主 + 手动保底**；hook 事件等某个宿主真有稳定会话尾事件时再单开。

### 4.3 其余小项

- 载荷上限：沿用 hub `maxContentBytes`（256 KiB）即可；原文是否暂存（抽取后即弃 vs 留 audit 痕迹）——默认即弃，只留候选与统计。
- 候选数量上限：单次 report ≤ 5 条（防刷）；每条照 asset/create 的校验。
- 草稿保留期：不自动过期（治理走 B.6 月度节奏），panel /inbox 空态提示手动清理。

## 5. 验收映射（sop 241 两条怎么测）

| 验收 | 测法（复用既有测试模式） |
|---|---|
| 草稿他人不可见 | member 建 draft → probe key `asset/get` 404/不可见 + `asset/search` 无命中——与 T8 probe 隔离用例同构 |
| 采纳后才可检索 | 同一 asset：activate 前 `searchAssets` 0 命中 → `inbox/adopt` → 命中；E2E 加进 `e2e-gate.mjs`（成员报会话 → 管理员看不到草稿 → 成员采纳 → 检索出现） |

## 6. 实现顺序（拍板后）

1. core：`createAsset` 加 `status` 入参（默认 active，零回归）+ `inbox/adopt` 复合动作。
2. sdk 类型 + hub：`session/report`（A' 形状：候选清单直落 draft；B' 形状等通道拍板再加）。
3. 入口：MCP `knowledge_session_report`（模型自报）+（可选）`ck distill`。
4. panel `/inbox`：草稿列表 + 三动作（编辑/采纳/丢弃），侧栏"治理"分组加菜单项。
5. e2e：`e2e-gate.mjs` 加沉淀段。

每步独立可测；1 与 2 不依赖 §4 拍板项（A' 的最小形状），3 起依赖。

## 7. 来源

本仓库：core/src/asset.ts:391,905 / core/src/access.ts:61,119-132 / core/src/search.ts / hub/src/actions.ts:474 / mcp/src/tools.ts:71-204 / docs/architecture.md:9；sop.md 241、decisions.md O-7、vector-search.md §4.3（通道选项同源）。
