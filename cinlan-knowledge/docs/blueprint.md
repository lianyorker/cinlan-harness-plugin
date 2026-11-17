# 落地蓝图：不变量、每层定案、红线

实现时**以本文为准**。想偏离任何一条，先改本文与 [decisions.md](decisions.md)，再写代码。

## 0. 全局不变量

1. **hub 是唯一事实源**。客户端只有配装缓存，没有同步引擎、没有本地版本。
2. **默认私有**。新资产一律 `private`；让别人看到必须是显式动作，团队策略决定是否过审。
3. **权限只实现一次**。`core/src/access.ts` 的 `canRead / canManage / accessibleSql`；检索、打开、配装、面板列表全部走它。不可见 = `NOT_FOUND`。
4. **先收窄再检索**。任何检索与配装先按 Team / User / Agent / 可见性收窄，再按 query 或优先级排序。
5. **注入计划服务端生成**。`loadout/resolve` 产出文本与 digest；客户端不拼接、不改写、不截断。唯一的例外是 `packages/mcp` 里的三段固定模板（`brief`、错误提示、缓存提示），它们不含任何资产内容。
6. **版本不可变 + 乐观并发**。改内容 = 新版本；修改必带 `base_version`；`content_hash` 只由 hub 计算。
7. **一个动作一个事务**。读-改-写在同一个同步事务内完成，中间不 `await`。
8. **全留痕**。所有写动作进 audit；audit 与日志不含正文、不含 key。
9. **不静默失败**。配置缺项启动即报全量问题并退出；错误枚举穷举映射，未知异常 = 500 `INTERNAL`。
10. **分层单向**。`panel / ck / MCP 宿主 → hub → core → SQLite`。import 规则：`sdk` 不 import 任何内部包；`core → sdk`；`mcp → sdk` + MCP SDK；`hub → core + mcp + sdk`；`cli → mcp + sdk`；`panel → sdk`。
11. **宿主差异是数据**。`agents/<host>/` 只有声明（`host.json`）、配置模板与手册，没有业务代码；`ck` 里没有宿主分支。

## 1. core

| 定案 | 来源 | 红线 |
| --- | --- | --- |
| 存储：`node:sqlite`，单文件 + WAL；只有 `db.ts` 能 import 它 | 腾讯是服务端注册表模型；本机 Node v24.9.0 实测可用 | 不在别处写 SQL 连接代码；换驱动只改 `db.ts` |
| 资产模型：Owner / 版本 / 状态 / 可见性 / ACL / 用量 | 腾讯统一记忆资产 | 不为某一类型开特例表；新类型 = `type` 新值 + 处理器 |
| 可见性四档 `private / team / restricted / agent` | 腾讯 | 不加第五档；任务域（`task`）不做 |
| 审批：`review_mode` + `allow_self_approve` | demo 的审批门，位置前移到"提升可见性" | 不恢复"每次写入都审" |
| 配装：`agent_asset` 一张绑定表；模板 = 拷贝 + 显式下发 | 腾讯 Fixed Binding + ACL、默认模板 | 不做运行期继承解析 |
| 检索：FTS5 `trigram` + 少于 3 字符的词走 `LIKE` 兜底；FTS 的 `rowid` 指向 `asset.seq` | 本机实测：trigram 对 2 字中文词 MATCH 返回 0；隐式 rowid 在 `VACUUM` 后无保证 | 向量 / RRF 是 P3，且须先过依赖审批 |
| id：服务端生成 `<前缀>_<24hex>`；`seq` 是内部整数主键 | demo 教训 | id 永不取自标题、文件名；`seq` 不出现在客户端契约里 |
| skill 名字唯一性按 `(team_id, type, owner_user_id, name)` | 多人各自导入同名 skill 是常态 | 提升到团队可见时在同一事务内校验团队内不重名 |

## 2. hub

| 定案 | 来源 | 红线 |
| --- | --- | --- |
| Node `http`，零框架；一条路由 + 动作注册表 | RPC 风格使路由退化成查表 | 不引 express / fastify / hono；要引先改 decisions |
| 全 POST、统一信封、大写错误枚举 | 腾讯面板 API 约定 | 不混入 REST 资源路由；枚举只增不改 |
| 认证：Bearer User Key，前缀查表 + `timingSafeEqual`；401 不带 OAuth 元数据 | 腾讯 user-key；demo 修正项；Claude Code 会因 401 进 OAuth 发现 | 配置文件里不出现任何 key；不做"管理员万能 token" |
| 运行面身份：`x-ck-agent-id`（`/api/v1`）或 `x-ck-agent: <team>/<name>`（`/mcp`），都必须属于该 user | 腾讯 `x-agent-id` 预选 | 不信任客户端声明的 user / team；`x-ck-host` 只做统计，不参与授权 |
| `POST /mcp`：无状态 Streamable HTTP，JSON 响应；由 `packages/mcp` 挂进动作注册表 | 多宿主是 P1 目标 | 不开服务端推送流、不发会话 id；`/mcp` 之外的地方不 import MCP SDK |
| `Origin` 校验：带 `Origin` 且不在 `allowedOrigins` → 403；认证只认 `Authorization` 头 | DNS rebinding | 不用 cookie 认证 |
| 单端口托管 API + `/mcp` + panel + `/dl` | 腾讯 combined 镜像的简化 | 不拆多服务多端口；`/dl` 不含密钥 |
| `/healthz` 只回 `{ ok }` | demo 修正项 | 库存统计只在 `system/stats` |

## 3. sdk

| 定案 | 来源 | 红线 |
| --- | --- | --- |
| 契约类型 + 错误枚举 + fetch client，零依赖 | 腾讯有 TS / Python SDK；我们只做 TS | 不放业务逻辑、不做缓存 |
| 契约 fixture 放这里，三方测试共用 | demo 的"三侧同步"教训 | 改 API 不改 fixture = 不合并 |

## 4. mcp / cli / agents

| 定案 | 来源 | 红线 |
| --- | --- | --- |
| `packages/mcp`：五个工具 `knowledge_search / open / save / share / status` + `instructions` 生成 + 固定模板；对 `Rpc` 接口编程 | 两段式（search + open）同腾讯 knowledge tools 与 mcp-memory；一份定义给 `/mcp` 与 `ck mcp` 共用 | 全仓库只有这个包 import MCP SDK；不加第六个工具，新能力优先加参数 |
| `packages/cli`（`ck`）：`login / setup / mcp / hook / skills / import / doctor / rpc` | 宿主侧唯一可执行文件 | 不实现权限、不拼配装文本、不写宿主分支 |
| `ck setup`：结构化合并宿主配置，dry-run 默认，`.bak` 备份，同名条目内容不同即拒绝 | 宿主配置格式各异（JSON / YAML / TOML） | 不覆盖他人条目；不做整文件重写式格式化 |
| 三种投递（hook / `instructions` / `tool`）同源，每宿主只用一种完整投递 | 宿主对超长文本的处置不同 | 不截断；超限降级为 `brief` + 重读提示 |
| skill 物化到宿主自己的用户级 skill 目录，平铺 + 标记文件 + 引用计数 | 宿主只下探一层；各家发现根不同 | 不嵌套目录；不碰无标记目录；`asset_id` 不符即冲突 |
| 缓存仅在网络类故障时兜底 | — | `401 / 403 / 404` 不用缓存并删本地文件 |
| `agents/<host>/`：`README.md` + `host.json` + `templates/` | 腾讯 `agents/<宿主>` 每端一份 | 不放业务代码；新宿主不改 `ck` 源码 |
| key：`CK_USER_KEY` > `ck login` 写入的本机文件；不进宿主配置（A0 除外） | demo：Desktop 上 `!!js process.env` 不可靠 | 明文 key 绝不进仓库；不打印完整 key |

## 5. panel

| 定案 | 来源 | 红线 |
| --- | --- | --- |
| React + Vite + TS SPA，产物由 hub 托管 | 腾讯 MemoryPanel 前端形态 | 依赖清单须先过审批（decisions §5） |
| 登录 = User Key | 腾讯 | 不做 SSO / OIDC |
| 模块：资产库、配装、团队、审批、访问控制、用量、审计 | 腾讯六个玩法 + 审批 | P2 不做知识工坊与 inbox |
| diff 在浏览器算，hub 只回两份原文 | — | hub 不引 diff 依赖 |

## 6. deploy

| 定案 | 来源 | 红线 |
| --- | --- | --- |
| `cinlan-knowledge serve --config knowledge.config.json` | 沿用 | 配置只有 `dataDir / listen / limits / log`（P3 加 `llm`），无密钥 |
| 首个管理员：`cinlan-knowledge bootstrap`，key 只打印一次 | — | 不提供"默认密码" |
| `/dl/ck.tgz` 与 sha256 随 hub release 一起构建 | 客户端与服务端版本配套 | 不改用手工分发 `ck` 包 |
| systemd：release 目录 + symlink `current` | 本仓库惯例 | 服务器上不 git pull |
| Docker：单镜像单端口，数据卷 `/data` | 腾讯 combined | — |
| 备份：`VACUUM INTO` 到 `backups/` | — | 不直接拷贝运行中的 db 文件 |

## 7. 明确不做（v1 最容易漂的方向）

- 本地文件与 hub 的双向同步、tombstone、冲突副本。
- 逐轮自动召回注入（默认永远是工具按需；会话开始注入只做一次）。
- KG / 实体抽取。向量检索与 RRF 留到 P3 评估。
- LLM 流量代理（P3 可选，仅为既无 MCP 也无 hook 的宿主）。
- 每个宿主一套原生插件（P3 可选，同上）。
- 任务（task）域、chat-memory 借用配额、参与日志。
- SSO / OIDC、多 hub 联邦。
- wiki / codegraph 的实现（P4 另立规格，P1 只留 `type` 位）。

## 8. PR 自查

1. 有没有绕过 `access.ts` 自己拼可见性条件？
2. 有没有让新资产一出生就不是 `private`，或让提升可见性绕过审批策略？
3. 动作 handler 里读-改-写之间有没有 `await`？有没有多表写没包事务？
4. 有没有让客户端传 hash、传 user / team 身份、或自己拼注入文本？
5. 新增或改动的动作，有没有漏写 audit、漏改动作目录或契约 fixture？
6. 有没有落在枚举之外的错误？有没有 `catch` 后吞掉或降级成 400？
7. 日志、audit、错误详情里有没有正文或 key？
8. 有没有引入未经审批的依赖？
9. `ck` 有没有在 `401 / 403 / 404` 时回退缓存？有没有碰无标记的 skill 目录？
10. `agents/<host>/` 里有没有出现业务逻辑？`ck` 里有没有出现宿主分支？
11. MCP SDK 有没有被 `packages/mcp` 之外的包 import？

任何一条答"是"，停下先改。
