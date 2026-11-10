#!/usr/bin/env node
/**
 * clh-knowledge-sync P1 作用域隔离冒烟验收。
 *
 * 与 e2e-demo.mjs（全 cordis 进程链路）互补：本脚本直接驱动 lib/ 产物，
 * 覆盖 scope.ts 语义、config 校验、hub HTTP 授权矩阵、engine push/pull 端到端、
 * 旧数据（无 scope 字段）迁移为全局层。运行：node demo/scope-smoke.mjs
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canRead, canWrite, grantCovers, isValidGrant, isValidScope,
  scopeAncestors, scopeFilePrefix, scopePathParts,
} from '../lib/scope.js'
import { resolveNodeConfig, validateHubConfig } from '../lib/config.js'
import { startHubServer } from '../lib/hub/server.js'
import { HubClient } from '../lib/node/http-client.js'
import { LocalStore } from '../lib/node/local-store.js'
import { SyncEngine } from '../lib/node/engine.js'

const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(DEMO_DIR, '.scope-smoke-tmp')

const results = []
const assert = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${JSON.stringify(detail).slice(0, 240)}` : ''}`)
}
const section = (t) => console.log(`\n===== ${t} =====`)
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 静音 logger（保留 error 供排障时肉眼定位）
const logger = { debug() {}, info() {}, warn() {}, error(ev, msg) { console.log(`  [${ev}] ${msg}`) } }

// ---------------- A: scope.ts 语义 ----------------
section('A: scope.ts 语义')
{
  assert('A1 isValidScope 合法形态', ['', 'proj:x', 'proj:x:mod:y', 'proj:a-b_c', 'proj:1:mod:2'].every(isValidScope))
  assert('A2 isValidScope 拒绝非法', ['proj', 'PROJ:x', 'proj:X', 'proj:x:', 'proj:x:mod:y:z', 'x:y', 'proj:x:mod:', ' mod:x'].every((s) => !isValidScope(s)))
  assert('A3 isValidGrant 合法', ['', '*', 'proj:*', 'proj:x', 'proj:x:*', 'proj:x:mod:y'].every(isValidGrant))
  assert('A4 isValidGrant 拒绝', ['proj', 'foo:*', '*:*', 'proj:x:**', '::'].every((s) => !isValidGrant(s)))
  assert('A5 grantCovers 精确', grantCovers('', '') && grantCovers('proj:x', 'proj:x') && !grantCovers('', 'proj:x') && !grantCovers('proj:x', 'proj:x:mod:y'))
  assert('A6 grantCovers 通配', grantCovers('*', 'proj:x:mod:y') && grantCovers('proj:*', 'proj:x') && grantCovers('proj:*', 'proj:x:mod:y') && !grantCovers('proj:*', '') && grantCovers('proj:x:*', 'proj:x:mod:y') && grantCovers('proj:x:*', 'proj:x') && !grantCovers('proj:x:*', 'proj:y'))
  assert('A7 canRead/canWrite=纯覆盖语义', canRead(['proj:x'], 'proj:x') && !canRead(['proj:x'], '') && !canRead(['proj:x'], 'proj:x:mod:y') && canWrite(['proj:x:*'], 'proj:x:mod:y') && !canWrite(['proj:x:*'], ''))
  assert('A8 scopeAncestors', eq(scopeAncestors(''), ['']) && eq(scopeAncestors('proj:x'), ['', 'proj:x']) && eq(scopeAncestors('proj:x:mod:y'), ['', 'proj:x', 'proj:x:mod:y']))
  assert('A9 scopePathParts/scopeFilePrefix', eq(scopePathParts(''), []) && eq(scopePathParts('proj:x:mod:y'), ['proj', 'x', 'mod', 'y']) && scopeFilePrefix('') === '' && scopeFilePrefix('proj:x:mod:y') === 'proj~x~mod~y__')
}

// ---------------- B: config 校验 ----------------
section('B: config 校验')
{
  const base = { listen: { protocol: 'http', host: '127.0.0.1', port: 1 }, auth: { adminToken: 'a' }, dataDir: '.' }
  const cfg1 = validateHubConfig({ ...base, auth: { adminToken: 'a', nodeTokens: { n1: 'tok' } } }, 'hub.config.json')
  assert('B1 旧 string token → scopes=["*"]', eq(cfg1.auth.nodeTokens.n1.scopes, ['*']))
  const cfg2 = validateHubConfig({ ...base, auth: { adminToken: 'a', nodeTokens: { n2: { token: 't', scopes: ['', 'proj:*'] } } } }, 'hub.config.json')
  assert('B2 对象形态 token+scopes（含 proj:* / ""）', eq(cfg2.auth.nodeTokens.n2.scopes, ['', 'proj:*']))
  let badGrant = false
  try { validateHubConfig({ ...base, auth: { adminToken: 'a', nodeTokens: { n3: { token: 't', scopes: ['bad'] } } } }, 'x.json') } catch { badGrant = true }
  assert('B3 非法 grant 被配置校验拒绝', badGrant)
  let emptyScopes = false
  try { validateHubConfig({ ...base, auth: { adminToken: 'a', nodeTokens: { n3: { token: 't', scopes: [] } } } }, 'x.json') } catch { emptyScopes = true }
  assert('B4 空 scopes 数组被拒', emptyScopes)

  const nodeRaw = {
    node: { id: 'n', token: 't' },
    hub: { activeProfile: 'p', profiles: { p: { protocol: 'http', host: '127.0.0.1', port: 1 } } },
    sync: { memoryDir: './m', scope: 'proj:a:mod:m' },
  }
  const r1 = resolveNodeConfig(nodeRaw, TMP)
  assert('B5 readScopes 缺省=写 scope 祖先闭包', r1.writeScope === 'proj:a:mod:m' && eq(r1.readScopes, ['', 'proj:a', 'proj:a:mod:m']))
  const r2 = resolveNodeConfig({ ...nodeRaw, sync: { ...nodeRaw.sync, readScopes: [''] } }, TMP)
  assert('B6 显式 readScopes:[""] 保留=仅全局', eq(r2.readScopes, ['']))
  let badScope = false
  try { resolveNodeConfig({ ...nodeRaw, sync: { ...nodeRaw.sync, scope: 'BAD' } }, TMP) } catch { badScope = true }
  assert('B7 非法 sync.scope 被拒', badScope)
}

// ---------------- C: hub HTTP 授权矩阵 ----------------
section('C: hub HTTP 授权矩阵')

await fsp.rm(TMP, { recursive: true, force: true })
const HUB_DATA = path.join(TMP, 'hub-data')
// 旧格式 published（无 scope 字段）→ 启动时应迁移为全局 ""
await fsp.mkdir(path.join(HUB_DATA, 'memory', 'published'), { recursive: true })
await fsp.writeFile(path.join(HUB_DATA, 'memory', 'published', 'mem-legacy.json'), JSON.stringify({
  kind: 'memory', id: 'mem-legacy', title: 'Legacy Entry', content: 'scope 引入前的旧数据', tags: ['legacy'],
  meta: {}, hash: 'h-legacy', version: 1, seq: 1, sourceNode: 'old-node', updatedAt: '2026-11-01T00:00:00.000Z',
}))

const TOK = {
  admin: 'adm',
  alpha: 't-alpha',      // ['','proj:alpha','proj:alpha:*'] — 项目全权
  beta: 't-beta',        // ['','proj:beta'] — 另项目 + 全局
  projonly: 't-proj',    // ['proj:alpha'] — 项目但无全局
  global: 't-glob',      // [''] — 仅全局
  legacy: 't-leg',       // '*'（旧 string 兼容）
}
const hubCfg = validateHubConfig({
  listen: { protocol: 'http', host: '127.0.0.1', port: 47612 },
  auth: {
    adminToken: TOK.admin,
    nodeTokens: {
      alpha: { token: TOK.alpha, scopes: ['', 'proj:alpha', 'proj:alpha:*'] },
      beta: { token: TOK.beta, scopes: ['', 'proj:beta'] },
      projonly: { token: TOK.projonly, scopes: ['proj:alpha'] },
      global: { token: TOK.global, scopes: [''] },
      legacy: TOK.legacy,
    },
  },
  dataDir: '.',
}, path.join(HUB_DATA, 'hub.config.json'))
const runtime = await startHubServer(hubCfg, logger)
const PORT = runtime.server.address().port
console.log(`  hub 已启动 :${PORT}`)

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const payload = (id, scope) => ({ kind: 'memory', id, scope, title: `t-${id}`, content: `c-${id}`, tags: [id], meta: {}, hash: `h-${id}`, updatedAt: '2026-11-10T10:00:00.000Z' })

// --- 推送授权 ---
{
  const r = await api('POST', '/api/v1/push', { token: TOK.alpha, body: { items: [payload('m-g', ''), payload('m-a', 'proj:alpha'), payload('m-am', 'proj:alpha:mod:web'), payload('m-bad', 'proj:beta')] } })
  const byId = Object.fromEntries((r.json?.results ?? []).map((x) => [x.id, x.status]))
  assert('C1 alpha 推送：""/proj/proj:mod 进队列，proj:beta 越权 invalid', eq(byId, { 'm-g': 'queued', 'm-a': 'queued', 'm-am': 'queued', 'm-bad': 'invalid' }), byId)
  const r2 = await api('POST', '/api/v1/push', { token: TOK.beta, body: { items: [payload('m-b', 'proj:beta')] } })
  assert('C2 beta 推 proj:beta → queued', r2.json?.results?.[0]?.status === 'queued', r2.json?.results)
  const r3 = await api('POST', '/api/v1/push', { token: TOK.projonly, body: { items: [payload('m-a2', 'proj:alpha'), payload('m-g2', '')] } })
  const by3 = Object.fromEntries((r3.json?.results ?? []).map((x) => [x.id, x.status]))
  assert('C3 projonly(无 "" 授权)：proj:alpha→queued，""→invalid', eq(by3, { 'm-a2': 'queued', 'm-g2': 'invalid' }), by3)
  const r4 = await api('POST', '/api/v1/push', { token: TOK.global, body: { items: [payload('m-g3', '')] } })
  assert('C4 global token 推 "" → queued', r4.json?.results?.[0]?.status === 'queued')

  // 全批准
  const pend = await api('GET', '/api/v1/admin/pending', { token: TOK.admin })
  const qids = (pend.json?.pending ?? []).map((p) => p.queueId)
  for (const queueId of qids) await api('POST', '/api/v1/admin/decisions', { token: TOK.admin, body: { queueId, action: 'approve' } })
  const ent = await api('GET', '/api/v1/admin/entries', { token: TOK.admin })
  // 队列 6 条（m-g,m-a,m-am,m-b,m-a2,m-g3）+ 迁移旧 1 条（mem-legacy）= 7
  assert('C5 批准 6 条 + 迁移旧 1 条 = 7 条已发布', (ent.json?.entries ?? []).length === 7, ent.json?.entries?.map((e) => `${e.scope || '""'}|${e.id}`))
  const legacyEntry = (ent.json?.entries ?? []).find((e) => e.id === 'mem-legacy')
  assert('C6 旧数据迁移为全局 scope', legacyEntry?.scope === '')
}

// --- 拉取可见性 ---
const pullIds = async (token, qs = '') => {
  const r = await api('GET', `/api/v1/pull?sinceSeq=0${qs}`, { token })
  return (r.json?.entries ?? []).map((e) => e.id).sort()
}
{
  const want = ['m-a', 'm-a2', 'm-am', 'm-g', 'm-g3', 'mem-legacy']
  assert('C7 alpha ?scopes=,proj:alpha,proj:alpha:mod:web → 全局+alpha 全家，不见 beta', eq(await pullIds(TOK.alpha, '&scopes=,proj:alpha,proj:alpha:mod:web'), want))
  assert('C8 alpha 不带 scopes → 用足授权(=通配展开)', eq(await pullIds(TOK.alpha), want))
  assert('C9 beta → 全局+proj:beta', eq(await pullIds(TOK.beta, '&scopes=,proj:beta'), ['m-b', 'm-g', 'm-g3', 'mem-legacy']))
  assert('C10 projonly ?scopes=,proj:alpha → 仅 proj:alpha（"" 被授权交集过滤）', eq(await pullIds(TOK.projonly, '&scopes=,proj:alpha'), ['m-a', 'm-a2']))
  assert('C11 global ?scopes= → 仅全局层', eq(await pullIds(TOK.global, '&scopes='), ['m-g', 'm-g3', 'mem-legacy']))
  assert('C12 legacy(*) 不带 scopes → 全部 7 条', (await pullIds(TOK.legacy)).length === 7)
  const badQ = await api('GET', '/api/v1/pull?scopes=proj:Bad', { token: TOK.legacy })
  assert('C13 非法 scopes 参数 → 400', badQ.status === 400, badQ.json?.error?.code)
}

// --- 检索可见性 ---
{
  const s1 = await api('GET', '/api/v1/search?q=m-', { token: TOK.beta })
  const ids1 = (s1.json?.results ?? []).map((r) => r.id).sort()
  // 检索匹配 title/tags/content，不查 id——mem-legacy 文本无 'm-' 字样不参与
  assert('C14 beta 检索只见 全局+proj:beta', eq(ids1, ['m-b', 'm-g', 'm-g3']))
  const s2 = await api('GET', '/api/v1/search?q=m-&scopes=,proj:alpha', { token: TOK.projonly })
  assert('C15 projonly 检索仅 proj:alpha', eq((s2.json?.results ?? []).map((r) => r.id).sort(), ['m-a', 'm-a2']))
  const scoped = (s1.json?.results ?? []).find((r) => r.id === 'm-b')
  assert('C16 检索命中带 scope 字段', scoped?.scope === 'proj:beta')
}

// --- 单条读取授权 ---
{
  const b1 = await api('GET', '/api/v1/entries/memory/m-b?scope=proj:beta', { token: TOK.beta })
  const b2 = await api('GET', '/api/v1/entries/memory/m-b?scope=proj:beta', { token: TOK.alpha })
  const b3 = await api('GET', '/api/v1/entries/memory/m-am', { token: TOK.alpha })
  const b4 = await api('GET', '/api/v1/entries/memory/m-am?scope=proj:alpha:mod:web', { token: TOK.alpha })
  const b5 = await api('GET', '/api/v1/entries/memory/m-g', { token: TOK.projonly })
  assert('C17 条目按 scope+授权读取：beta↔m-b=200，alpha↔m-b=404(不泄露存在)', b1.status === 200 && b2.status === 404)
  assert('C18 scope 消歧：m-am 不带 scope 404，带 scope 200', b3.status === 404 && b4.status === 200)
  assert('C19 projonly 读全局 m-g → 404', b5.status === 404)
}

// --- admin 浏览 ---
{
  const e1 = await api('GET', '/api/v1/admin/entries?scope=proj:alpha', { token: TOK.admin })
  const e2 = await api('GET', '/api/v1/admin/entries/memory/m-a?scope=proj:alpha', { token: TOK.admin })
  const e3 = await api('GET', '/api/v1/admin/entries/memory/m-a?scope=', { token: TOK.admin })
  assert('C20 admin ?scope=proj:alpha → [m-a,m-a2]；详情按 scope 取', eq((e1.json?.entries ?? []).map((x) => x.id).sort(), ['m-a', 'm-a2']) && e2.status === 200)
  assert('C21 admin 详情 scope 消歧：?scope= 取全局 m-a → 404', e3.status === 404)
  const e4 = await api('GET', '/api/v1/admin/entries/memory/m-g?scope=', { token: TOK.admin })
  assert('C22 admin 详情 ?scope= 取全局 m-g → 200', e4.status === 200)
}

// --- budget / 时态过滤（借鉴 hindsight recall 语义） ---
{
  // 推一条过期条目进全局：updatedAt/expires 都设到 2020，方便时态断言
  const r = await api('POST', '/api/v1/push', {
    token: TOK.global,
    body: { items: [{ ...payload('m-exp', ''), expires: '2020-06-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }] },
  })
  const qid = r.json?.results?.[0]?.queueId
  await api('POST', '/api/v1/admin/decisions', { token: TOK.admin, body: { queueId: qid, action: 'approve' } })

  const big = await api('GET', '/api/v1/search?q=m-&limit=50', { token: TOK.legacy })
  // 测试条目很小（每条 ~7 estTokens），budget 调小到能产生截断的量级
  const small = await api('GET', '/api/v1/search?q=m-&limit=50&budget=25', { token: TOK.legacy })
  const sumTokens = (rs) => (rs ?? []).reduce((a, h) => a + (h.estTokens ?? 0), 0)
  assert('C23 budget=25 → 命中被预算截断且附正文', (small.json?.results ?? []).length < (big.json?.results ?? []).length && small.json.results.every((h) => typeof h.content === 'string' && h.estTokens > 0) && sumTokens(small.json.results) > 0 && sumTokens(small.json.results) <= Math.max(25, small.json.results[0].estTokens), { hits: small.json?.results?.length, tokens: sumTokens(small.json?.results) })

  const future = await api('GET', '/api/v1/search?q=m-&limit=50&since=2099-01-01', { token: TOK.legacy })
  const old = await api('GET', '/api/v1/search?q=m-&limit=50&before=2021-01-01', { token: TOK.legacy })
  assert('C24 since=2099 → 0 命中；before=2021 → 仅 m-exp', (future.json?.results ?? []).length === 0 && eq((old.json?.results ?? []).map((x) => x.id), ['m-exp']))
  const exp = await api('GET', '/api/v1/search?q=m-&limit=50&expiredOnly=true', { token: TOK.legacy })
  assert('C25 expiredOnly → 仅已过期 m-exp', eq((exp.json?.results ?? []).map((x) => x.id), ['m-exp']))
  const badB = await api('GET', '/api/v1/search?q=x&budget=abc', { token: TOK.legacy })
  const badD = await api('GET', '/api/v1/search?q=x&since=not-a-date', { token: TOK.legacy })
  assert('C26 非法 budget/since → 400', badB.status === 400 && badD.status === 400)
}

// ---------------- D: engine 端到端（push→approve→pull→tombstone） ----------------
section('D: engine 端到端')

const NODE_DIR = path.join(TMP, 'node-alpha')
const memoryMd = `---\nid: mem-mod\n title: Mod Note\ntags: [mod]\nupdatedAt: 2026-11-10T10:00:00.000Z\n---\n\nmod 层记忆内容`
await fsp.mkdir(path.join(NODE_DIR, 'memory'), { recursive: true })
await fsp.writeFile(path.join(NODE_DIR, 'memory', 'mod-note.md'), memoryMd)
await fsp.mkdir(path.join(NODE_DIR, 'skills', 'skill-mod'), { recursive: true })
await fsp.writeFile(path.join(NODE_DIR, 'skills', 'skill-mod', 'SKILL.md'), `---\nname: skill-mod\ndescription: scoped skill\n---\n\n# skill-mod\n`)

const nodeCfg = {
  nodeId: 'alpha',
  token: TOK.alpha,
  profile: { name: 't', protocol: 'http', host: '127.0.0.1', port: PORT, basePath: '', timeoutMs: 8000, token: TOK.alpha, rejectUnauthorized: true },
  auto: false, intervalSec: 300, syncOnStart: false,
  memoryDir: path.join(NODE_DIR, 'memory'),
  skillRoots: [path.join(NODE_DIR, 'skills')],
  writeScope: 'proj:alpha:mod:web',
  readScopes: ['', 'proj:alpha', 'proj:alpha:mod:web'],
  stateDir: path.join(NODE_DIR, 'memory', '.clh-knowledge-sync'),
  logLevel: 'info', logDir: '',
  oneshot: { enabled: false, commands: [], resultFile: '' },
}
const client = new HubClient(nodeCfg.profile, logger)
const local = new LocalStore(nodeCfg, logger)
const engine = new SyncEngine(nodeCfg, client, local, logger)
await engine.loadState()

{
  const r = await engine.pushCycle()
  assert('D1 engine pushCycle 推送 memory+skill', r.ok === true && r.counts.pushed === 2, r.details)
  const state = engine.stateSnapshot()
  const keys = Object.keys(state.pushed).sort()
  assert('D2 pushed 状态键 = scope|id', keys.some((k) => k.startsWith('proj:alpha:mod:web|')), keys)

  const pend2 = await api('GET', '/api/v1/admin/pending', { token: TOK.admin })
  const mine = (pend2.json?.pending ?? []).filter((p) => p.node === 'alpha' && p.scope === 'proj:alpha:mod:web')
  assert('D3 pending 携带 scope=proj:alpha:mod:web', mine.length === 2, mine.map((p) => `${p.kind}:${p.id}`))
  for (const p of mine) await api('POST', '/api/v1/admin/decisions', { token: TOK.admin, body: { queueId: p.queueId, action: 'approve' } })

  // hub 侧文件名带 scope 前缀
  const pubFiles = await fsp.readdir(path.join(HUB_DATA, 'memory', 'published'))
  assert('D4 published 文件名 = proj~alpha~mod~web__<id>.json', pubFiles.some((f) => f === 'proj~alpha~mod~web__mem-mod.json'), pubFiles)

  const pull = await engine.pullCycle()
  // mem-mod 本地有同 hash 原文件 → pull 判 unchanged 不写 shared（自推回环语义）；
  // scoped 落盘验证用 alpha 经 HTTP 直推的 m-am（本地无源文件 → 必定 written）
  const scopedFile = path.join(NODE_DIR, 'memory', 'shared', 'proj', 'alpha', 'mod', 'web', 'm-am.md')
  const gotScoped = await fsp.access(scopedFile).then(() => true, () => false)
  assert('D5 pull 后 scoped memory 落 shared/proj/alpha/mod/web/', pull.ok && gotScoped, pull.details)
  const skillDir = path.join(NODE_DIR, 'skills', 'proj', 'alpha', 'mod', 'web', 'skill-mod', 'SKILL.md')
  const gotSkill = await fsp.access(skillDir).then(() => true, () => false)
  assert('D6 pull 后 scoped skill 落 skills/proj/alpha/mod/web/', gotSkill)

  // 全局层 pull 落 shared/ 根（兼容布局）
  const globalFile = path.join(NODE_DIR, 'memory', 'shared', 'm-g.md')
  const gotGlobal = await fsp.access(globalFile).then(() => true, () => false)
  assert('D7 readScopes 含 "" → 全局 m-g 落 shared/ 根', gotGlobal)

  // tombstone：清理 scoped 条目 m-am → 下次 pull 删除 scoped 副本，不动全局/本地
  await api('POST', '/api/v1/admin/cleanup/propose', { token: TOK.admin, body: { ids: [{ kind: 'memory', id: 'm-am', scope: 'proj:alpha:mod:web' }], reason: 'smoke' } })
  const dec = await api('POST', '/api/v1/admin/cleanup/decide', { token: TOK.admin, body: { ids: [{ kind: 'memory', id: 'm-am', scope: 'proj:alpha:mod:web' }], action: 'approve', reason: 'smoke' } })
  assert('D8 cleanup 按 scope 定位删除', dec.json?.results?.[0]?.status === 'archived', dec.json?.results)
  const pull2 = await engine.pullCycle()
  const stillScoped = await fsp.access(scopedFile).then(() => true, () => false)
  const stillGlobal = await fsp.access(globalFile).then(() => true, () => false)
  const stillLocal = await fsp.access(path.join(NODE_DIR, 'memory', 'mod-note.md')).then(() => true, () => false)
  assert('D9 tombstone 下发后 scoped 副本删除、全局/本地不受影响', pull2.ok && !stillScoped && stillGlobal && stillLocal, pull2.details)
}

await runtime.close()
await fsp.rm(TMP, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} PASS =====`)
for (const f of failed) console.log(`  FAIL ${f.name}`)
process.exitCode = failed.length ? 1 : 0
