# P4 规格：wiki / codegraph 与 Knowledge Workshop（sop.md 247 + 248）

状态：规格起草完成（2026-11-16，按 A.0「超出文档先分析」），待拍板 §5 清单后开工。
两个未勾项是一块：`/workshop` 就是 wiki / codegraph 的玩法页（architecture.md §8 已定位）。

**2026-11-16 更新：§5 四问已按 O-43 授权（LY「按最优继续拍板」）拍板并落地 P4-1**——放行两 type / wiki 第一版纯长文 / codegraph 构建器出线 / JSON 与文本都收。core 枚举两处放行 + `p4.test.ts`，实机（dev hub）建 wiki → 共享 → `types=wiki` 检索全通。P4-2（Workshop 玩法页）维持观察驱动缓议。

## 0. 结论先行

| 子项 | 最小切片 | 定性 |
|---|---|---|
| **wiki** | **type 放行 + 校验规则 + 默认送法 tool**——纯类型放行，其余全部复用（版本/审批/权限/ACL/用量/审计/FTS/配装/注入/E-9 向量回填） | 小工程：core 两处枚举 + 两条校验 + 文档 |
| **codegraph** | 同上放行，内容形态钉为「预摘要文本或 JSON 均可，一律当文本资产对待」；**图谱构建器不做**（外部工具产出、`asset/create` 落库） | 同 wiki；构建器明确出线 |
| **Workshop 页** | **先不做独立页**——wiki 列表/详情用 `/assets` 的类型过滤即得（panel 的 TYPE_OPTIONS 已含 wiki/codegraph，今天点创建会被 core 拒）；等类型放行后真用起来，再决定要不要 `/workshop`（目录树/图谱可视化） | 观察驱动，避免纸面先行 |

一句话：**P4 第一刀是「把 sdk 枚举里早就存在的两个 type 在 core 放行」，不是建新玩法。** 权限 / 配装 / 审批 / 用量按 sop 247 原文即「复用现有实现」——实测确认它们全部 type 无关（见 §2）。

## 1. 现状事实（2026-11-16 核实）

| 事实 | 位置 |
|---|---|
| sdk `AssetType = "memory" \| "skill" \| "wiki" \| "codegraph"` | sdk/entities.ts:8 |
| core 创建/检索只认 memory/skill：`ASSET_TYPES`（asset.ts:45）、search `TYPES`（search.ts:18）——**wiki/codegraph 今天建不了、检索 types 参数也会拒** | asset.ts:356,533；search.ts:18 |
| panel 的类型选项**已经**列出 Wiki / 代码图（用户能选，后端拒）——label 映射也齐 | Assets.tsx:31-36；format.ts:42-47 |
| system stats 已按四类 tally（wiki/codegraph 恒为 0） | system.ts:24,68 |
| loadout 渲染对非 skill 类型一律走通用块：core 注入块 `## title (id vN) + content`、catalog 行、knowledge_open 全文——**type 无关，wiki/codegraph 资产绑上配装今天就能注入**（放行后零改动） | loadout.ts:336,444-498 |
| FTS / 版本 / 审批 / ACL / 用量 / 审计全部 type 无关 | asset.ts/review.ts/usage.ts/audit.ts 全文 |
| O-9 阶段一整条资产一个向量，**wiki/codegraph 的分块（阶段二）** | vector-search.md §4.1「大内容分块留给阶段二」 |
| 腾讯侧对照：「统一记忆资产：Chat Memory / Skill / Wiki / CodeGraph」 | comparison.md §数据模型 |

## 2. 设计

### 2.1 wiki（阶段 P4-1，提议直接做）

- **数据模型**：零 schema 变更。一条 wiki = 一份 Markdown 长文，`content` 上限沿用 256 KiB（一篇几万字绰绰有余）；`layer` 不适用（memory 专属）；`name` 不要求（skill 专属）。
- **校验规则**：type=wiki 时拒绝 `layer` / `files`（同 skill 的「files only apply to skill」句式）。
- **默认送法**：配装绑定时建议 `tool`（体量大，靠 knowledge_open 按需取全文）——这是文档/引导层的事，不是硬约束；coreBlock 注入在预算内照常降级（现有机制）。
- **检索**：FTS trigram 对中文 Markdown 直接有效；`asset/search` 的 `types` 放行 wiki。
- **向量**：O-9 回填对 wiki 整条向量（阶段一策略）；超长 wiki 的分块留给阶段二（vector-search.md 已留位）。
- **[[链接]] / 树形目录**：不做。版本历史 + 标题检索已够第一轮；真实使用里若有人喊"要目录树"，再立 Workshop 页。

### 2.2 codegraph（阶段 P4-1 同批，仅放行）

- **内容形态**：`content` = 预摘要文本（推荐，FTS 直接可检）或 JSON 图数据（nodes/edges）——**一律当文本资产对待**，不解析、不建图查询。
- **图谱构建器明确出线**：谁产出摘要/JSON 是外部工具的事（腾讯侧的 codegraph 也是管线产物）；入库走 `asset/create`，将来可以加 `ck codegraph import` 一类的 CLI 入口，但 P4 不做。
- 其余与 wiki 完全相同（权限/审批/配装/用量/向量）。

### 2.3 Workshop 页（阶段 P4-2，观察驱动，暂不开工）

放行后 `/assets?types=wiki` 就是现成的 wiki 列表（过滤条已支持 types）。**只有当真实使用暴露出刚需**（目录树、双链、图谱可视化）才立项 `/workshop`——腾讯六玩法里它是唯一未取的，但「玩法页」是展示层，资产层先通才是顺序。architecture.md §8 的 `/workshop` 行维持 P4 定位不动。

## 3. 实现顺序（拍板后）

1. **core**：`ASSET_TYPES` += wiki、codegraph（asset.ts:45、search.ts:18 两处）；校验——非 memory 拒 layer、非 skill 拒 files（现有 `layer only applies to memory` 已通用？确认后补 wiki/codegraph 的用例即可）。
2. **测试**：core asset/search 用例 +2（wiki 建立检索可中、codegraph JSON 可存可检）；hub 契约不动（fixture 走 memory，不涉新面）。
3. **文档**：api.md §3 类型行、data-model.md 类型表、loadout.md 送法建议（tool 优先）。
4. **实机**：panel 上建一条真 wiki → 绑配装 tool → knowledge_open 取回 → 检索命中（用 dev hub 走一遍，无需新脚本）。

预计 1+2 半天内完成——这是全项目剩余项里性价比最高的一件。

## 4. 与其他线的关系

- **O-9 阶段二（分块）**：wiki 放行后若出现超长文档再启用分块，两线互不阻塞。
- **深层记忆（v2）**：wiki 的「自更新常驻页」形态与 deep-memory.md 的 pages 结论同构——wiki 类型放行正好是那个方向的存储底座，P4 不做自动重写。

## 5. 待拍板清单（LY/Yorker）

1. P4-1 按本规格走（放行两 type、Workshop 页缓议）？
2. wiki 不做 [[链接]] / 目录树——接受「第一版就是带版本管理的长文」？
3. codegraph 构建器出线（外部工具产出、P4 只管存取）？
4. codegraph 内容形态允许 JSON（不做解析）还是钉死纯文本摘要（更简单，但少一种用法）？

## 6. 来源

本仓库：sdk/entities.ts:8、core asset.ts:45,356,533 / search.ts:18 / system.ts:24 / loadout.ts:336-498、panel Assets.tsx:31 / format.ts:42、architecture.md §8（`/workshop` 定位）、comparison.md（腾讯侧统一资产模型与六玩法）、sop.md 247-248、vector-search.md §4.1、deep-memory.md §2（pages 同构）。
