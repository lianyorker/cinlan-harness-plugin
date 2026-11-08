#!/usr/bin/env node
/**
 * clh-knowledge-sync 端到端验收。
 *
 * 拓扑：hub（独立进程）+ 节点 A（常驻 cordis，自动同步）+ 节点 B（oneshot 手动驱动）+ 节点 C（坏地址）。
 * 全部经真实组件：hub 用 bin/hub.js，节点用 vendor/cordis 加载器挂载 @cinlan/clh-knowledge-sync 插件。
 *
 * 断言清单（对应完成标准）：
 *  01 hub healthz 就绪
 *  02 节点 A 自动把 3 条记忆 + 1 个 skill 推进待审批队列
 *  03 审批通过的条目已发布（GET 200）；未审批/被拒条目不在总库（GET 404）
 *  04 检索 API 能命中已发布条目
 *  05 节点 B oneshot：doctor/pull/push/status/search 全部执行成功
 *  06 B 推送同 id 不同内容 → 明确 conflict（含 serverVersion）；自有新条目 → queued
 *  07 B 拉取冲突时本地内容被保全为冲突副本，远端副本不覆盖本地
 *  08 节点 A 能读到审批结果：被拒条目带 reason，被批条目带 version
 *  09 审批后 B 能拉到共享记忆（写入 shared/）与共享 skill（写入技能目录）
 *  10 清理扫描发现过期条目
 *  11 清理提议→标记→审批→归档+tombstone，总库中条目消失（GET 404）
 *  12 B 下一次 pull 收到 tombstone，自动删除本地共享副本
 *  13 节点 C 配置指向不可达端口 → connect-failed，oneshot 失败、退出码 1
 *  14 审计日志完整记录 approve/reject/cleanup 动作
 *  15 admin CLI（clh-knowledge-sync admin stats）可用
 */
import { spawn, spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url))
const HARNESS_DIR = path.resolve(PKG_DIR, '..', '..', 'cinlan-harness')
const CORDIS_BIN = path.join(HARNESS_DIR, 'vendor', 'cordis', 'bin.js')
const HUB_PORT = 47610
const BAD_PORT = 47611

const results = []
function assert(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
}
function section(title) {
  console.log(`\n===== ${title} =====`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn, { timeoutMs = 20000, every = 300, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  throw new Error(`等待超时(${timeoutMs}ms): ${what}，最后值=${JSON.stringify(last)?.slice(0, 200)}`)
}

async function api(method, pathName, { token, body, expectStatus } = {}) {
  const res = await fetch(`http://127.0.0.1:${HUB_PORT}${pathName}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  if (expectStatus && res.status !== expectStatus) {
    throw new Error(`API ${method} ${pathName} 期望 ${expectStatus} 实得 ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
  }
  return { status: res.status, json }
}

async function ensureJunction(link, target) {
  // 总是重建：上一轮可能留下指向旧路径的坏 junction
  await fsp.rm(link, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(link), { recursive: true })
  await fsp.symlink(target, link, 'junction')
}

async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true })
}

// ---------------- 种子内容 ----------------

const nodeConfig = (id, token, port, { auto, oneshot, intervalSec = 3 } = {}) => JSON.stringify({
  node: { id, token },
  hub: {
    activeProfile: 'intranet',
    profiles: { intranet: { protocol: 'http', host: '127.0.0.1', port, timeoutMs: 5000 } },
  },
  sync: {
    auto: Boolean(auto),
    intervalSec,
    syncOnStart: auto,
    memoryDir: './memory',
    skillRoots: ['./skills'],
    stateDirName: '.clh-knowledge-sync',
  },
  oneshot: oneshot ?? { enabled: false, commands: [], resultFile: '' },
  log: { level: 'info' },
}, null, 2)

const hubConfig = JSON.stringify({
  listen: { protocol: 'http', host: '127.0.0.1', port: HUB_PORT },
  auth: { adminToken: 'demo-admin-token', nodeTokens: { 'node-a': 'token-a', 'node-b': 'token-b', 'node-c': 'token-c' } },
  dataDir: './hub-data',
  limits: { maxBodyBytes: 20971520, maxFileBytes: 5242880, maxItemsPerPush: 100 },
  log: { level: 'info' },
}, null, 2)

// 节点 A：3 条记忆（一条批准、一条将被拒、一条带过期时间先留 pending）+ 1 个 skill
const memoryA1 = `---
title: Deploy Notes
tags: [deploy, node-a]
updatedAt: 2026-11-08T10:00:00.000Z
---

node-a 独有内容标记 MARKER_FROM_NODE_A：部署分三步：构建、上传、切流。`
const memoryA2 = `---
title: Project Conventions
tags: [convention]
updatedAt: 2026-11-08T10:05:00.000Z
---

这条会被管理员以"标题太泛"为由拒绝。`
const memoryA3 = `---
title: Runbook Expired
tags: [runbook]
expires: 2026-11-01T00:00:00.000Z
updatedAt: 2026-11-08T10:10:00.000Z
---

这条已过期，用于清理流程验收。`
const skillA = `---
name: demo-greet
description: clh-knowledge-sync demo skill：按问候语模板生成回复
---

# demo-greet

用法：读取 templates/greeting.txt 并按名字渲染。`
const skillAExtra = `Hello, {{name}}! (from node-a demo-greet)`

// 节点 B：与 A 的 Deploy Notes 同 id 不同内容（推送冲突 + 拉取冲突各测一次）、自有新条目、自有 skill
const memoryB1 = `---
id: mem-deploy-notes
title: Deploy Notes (node B copy)
tags: [deploy, node-b]
updatedAt: 2026-11-08T11:00:00.000Z
---

node-b 的本地版本，内容与 node-a 不同：部署只有两步：构建、直发。`
const memoryB2 = `---
title: B Local Note
tags: [b-local]
updatedAt: 2026-11-08T11:05:00.000Z
---

node-b 独有记忆，等待管理员审批后供 A 读取。`
const skillB = `---
name: b-own-skill
description: node-b 本地自有 skill
---

# b-own-skill

node-b 本地技能。`

const cordisYml = (extra = '') => `- name: '@cinlan/clh-knowledge-sync'
  config:
${extra}`

function yamlNodeConfig(id, token, port, opts) {
  const cfg = JSON.parse(nodeConfig(id, token, port, opts))
  const block = (obj, indent) => Object.entries(obj).map(([k, v]) => {
    const pad = ' '.repeat(indent)
    if (v !== null && typeof v === 'object') {
      const inner = Object.entries(v).map(([k2, v2]) => `${' '.repeat(indent + 2)}${k2}: ${typeof v2 === 'string' && (k2 === 'protocol' || k2 === 'host') ? `'${v2}'` : JSON.stringify(v2)}`).join('\n')
      return `${pad}${k}:\n${inner}`
    }
    return `${pad}${k}: ${JSON.stringify(v)}`
  }).join('\n')
  return `${cordisYml()}${''}    node:\n      id: ${id}\n      token: ${token}\n    hub:\n      activeProfile: intranet\n      profiles:\n        intranet:\n          protocol: http\n          host: '127.0.0.1'\n          port: ${port}\n          timeoutMs: 5000\n    sync:\n      auto: ${Boolean(opts?.auto)}\n      intervalSec: ${opts?.intervalSec ?? 3}\n      syncOnStart: ${Boolean(opts?.auto)}\n      memoryDir: ./memory\n      skillRoots:\n        - ./skills\n      stateDirName: .clh-knowledge-sync\n    oneshot:\n      enabled: ${Boolean(opts?.oneshot)}\n      commands: ${opts?.oneshot ? JSON.stringify(opts.oneshot.commands) : '[]'}\n      resultFile: ${opts?.oneshot?.resultFile ? `'${opts.oneshot.resultFile}'` : "''"}\n    log:\n      level: info\n`
}

// ---------------- 主流程 ----------------

async function main() {
  console.log('clh-knowledge-sync e2e demo — 全部组件均为真实进程')
  console.log(`包目录: ${PKG_DIR}\n`)

  section('准备：junction、配置、种子内容、清理旧数据')
  const peerTargets = {
    '@deepseek-ai/cordis': path.join(HARNESS_DIR, 'vendor', 'cordis'),
    '@deepseek-ai/schemastery': path.join(HARNESS_DIR, 'vendor', 'schemastery'),
    '@deepseek-ai/dsh-tools': path.join(HARNESS_DIR, 'packages', 'core', 'tools'),
  }
  for (const [pkg, target] of Object.entries(peerTargets)) {
    await ensureJunction(path.join(PKG_DIR, 'node_modules', pkg), target)
  }
  for (const node of ['node-a', 'node-b', 'node-c']) {
    await ensureJunction(path.join(DEMO_DIR, node, 'node_modules', '@cinlan', 'clh-knowledge-sync'), PKG_DIR)
  }
  await rmrf(path.join(DEMO_DIR, 'hub-data'))
  for (const node of ['node-a', 'node-b', 'node-c']) {
    await rmrf(path.join(DEMO_DIR, node, 'memory', 'shared'))
    await rmrf(path.join(DEMO_DIR, node, 'memory', '.clh-knowledge-sync'))
    await rmrf(path.join(DEMO_DIR, node, 'skills', 'demo-greet'))
    for (const f of await fsp.readdir(DEMO_DIR).catch(() => [])) {
      if (f.startsWith(`oneshot-${node}`)) await rmrf(path.join(DEMO_DIR, f))
    }
  }
  await write(path.join(DEMO_DIR, 'hub.config.json'), hubConfig)
  for (const node of ['node-a', 'node-b', 'node-c']) {
    // loader 的包名解析从 cordis.yml 目录向上找 package.json 建 scope；节点目录必须自带一个
    await write(path.join(DEMO_DIR, node, 'package.json'), JSON.stringify({ name: `@demo/${node}`, private: true, type: 'module' }, null, 2))
    // include/loader 自身也按 scope 解析，节点目录要能解析到它们
    await ensureJunction(path.join(DEMO_DIR, node, 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), path.join(HARNESS_DIR, 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'))
    await ensureJunction(path.join(DEMO_DIR, node, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'), path.join(HARNESS_DIR, 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'))
  }
  await write(path.join(DEMO_DIR, 'node-a', 'node.config.json'), nodeConfig('node-a', 'token-a', HUB_PORT, { auto: true }))
  await write(path.join(DEMO_DIR, 'node-a', 'cordis.yml'), yamlNodeConfig('node-a', 'token-a', HUB_PORT, { auto: true, intervalSec: 3 }))
  await write(path.join(DEMO_DIR, 'node-a', 'memory', 'deploy-notes.md'), memoryA1)
  await write(path.join(DEMO_DIR, 'node-a', 'memory', 'project-conventions.md'), memoryA2)
  await write(path.join(DEMO_DIR, 'node-a', 'memory', 'runbook-expired.md'), memoryA3)
  await write(path.join(DEMO_DIR, 'node-a', 'skills', 'demo-greet', 'SKILL.md'), skillA)
  await write(path.join(DEMO_DIR, 'node-a', 'skills', 'demo-greet', 'templates', 'greeting.txt'), skillAExtra)
  await write(path.join(DEMO_DIR, 'node-b', 'node.config.json'), nodeConfig('node-b', 'token-b', HUB_PORT, { auto: false }))
  await write(path.join(DEMO_DIR, 'node-b', 'cordis.yml'), yamlNodeConfig('node-b', 'token-b', HUB_PORT, { auto: false, oneshot: { enabled: true, commands: ['doctor', 'pull', 'push', 'status', 'search deploy'], resultFile: './oneshot-node-b.json' } }))
  await write(path.join(DEMO_DIR, 'node-b', 'memory', 'deploy-notes.md'), memoryB1)
  await write(path.join(DEMO_DIR, 'node-b', 'memory', 'b-local-note.md'), memoryB2)
  await write(path.join(DEMO_DIR, 'node-b', 'skills', 'b-own-skill', 'SKILL.md'), skillB)
  await write(path.join(DEMO_DIR, 'node-c', 'node.config.json'), nodeConfig('node-c', 'token-c', BAD_PORT, { auto: false, oneshot: { enabled: true, commands: ['doctor'], resultFile: './oneshot-node-c.json' } }))
  await write(path.join(DEMO_DIR, 'node-c', 'cordis.yml'), yamlNodeConfig('node-c', 'token-c', BAD_PORT, { auto: false, oneshot: { enabled: true, commands: ['doctor'], resultFile: './oneshot-node-c.json' } }))
  console.log('配置与种子已生成')

  // ---------- 阶段 1：启动 hub ----------
  section('阶段 1：启动 hub')
  const hubProc = spawn(process.execPath, [path.join(PKG_DIR, 'bin', 'hub.js'), '--config', 'hub.config.json'], { cwd: DEMO_DIR })
  const hubLogs = []
  hubProc.stdout.on('data', (d) => hubLogs.push(d.toString()))
  hubProc.stderr.on('data', (d) => hubLogs.push(d.toString()))
  try {
    await waitUntil(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${HUB_PORT}/healthz`)
        return r.ok ? await r.json() : null
      } catch { return null }
    }, { what: 'hub healthz', timeoutMs: 15000 })
    assert('01 hub healthz 就绪', true)
  } catch (err) {
    assert('01 hub healthz 就绪', false, { error: String(err), logs: hubLogs.slice(-10).join('') })
    hubProc.kill()
    return finish(hubLogs)
  }

  // ---------- 阶段 2：节点 A 常驻（自动同步推送） ----------
  section('阶段 2：节点 A 启动（真实 cordis 加载插件，自动同步推送）')
  const aProc = spawn(process.execPath, [CORDIS_BIN], { cwd: path.join(DEMO_DIR, 'node-a') })
  const aLogs = []
  aProc.stdout.on('data', (d) => aLogs.push(d.toString()))
  aProc.stderr.on('data', (d) => aLogs.push(d.toString()))

  let queueIds = {}
  try {
    const pending = await waitUntil(async () => {
      try {
        const { json } = await api('GET', '/api/v1/admin/pending', { token: 'demo-admin-token' })
        const items = json?.pending ?? []
        for (const it of items) queueIds[`${it.kind}:${it.id}`] = it.queueId
        return items.length >= 4 ? items : null
      } catch { return null }
    }, { what: 'A 的 4 条推送进入待审批队列', timeoutMs: 30000 })
    assert('02 节点 A 自动推送 3 记忆 + 1 skill 进待审批队列', pending.length === 4, { pending: pending.map((p) => `${p.kind}:${p.id}`) })
  } catch (err) {
    assert('02 节点 A 自动推送 3 记忆 + 1 skill 进待审批队列', false, { error: String(err), aLogsTail: aLogs.slice(-15).join('') })
  }

  // ---------- 阶段 3：审批门（approve x2 / reject x1 / 留 1 条 pending） ----------
  section('阶段 3：管理员审批（批准 Deploy Notes + demo-greet，拒绝 Project Conventions，Runbook 留 pending）')
  try {
    const r1 = await api('POST', '/api/v1/admin/decisions', { token: 'demo-admin-token', body: { queueId: queueIds['memory:mem-deploy-notes'], action: 'approve' }, expectStatus: 200 })
    const r2 = await api('POST', '/api/v1/admin/decisions', { token: 'demo-admin-token', body: { queueId: queueIds['skill:demo-greet'], action: 'approve' }, expectStatus: 200 })
    const r3 = await api('POST', '/api/v1/admin/decisions', { token: 'demo-admin-token', body: { queueId: queueIds['memory:mem-project-conventions'], action: 'reject', reason: '标题太泛，请补充适用范围' }, expectStatus: 200 })
    assert('03a 审批动作被 hub 接受', r1.json.status === 'approved' && r2.json.status === 'approved' && r3.json.status === 'rejected', { r1: r1.json, r2: r2.json, r3: r3.json })
  } catch (err) {
    assert('03a 审批动作被 hub 接受', false, { error: String(err) })
  }

  try {
    const pub = await api('GET', '/api/v1/entries/memory/mem-deploy-notes', { token: 'token-b', expectStatus: 200 })
    let pending404 = false
    try { pending404 = (await api('GET', '/api/v1/entries/memory/mem-runbook-expired', { token: 'token-b' })).status === 404 } catch { /* 网络错不算通过 */ }
    let rejected404 = false
    try { rejected404 = (await api('GET', '/api/v1/entries/memory/mem-project-conventions', { token: 'token-b' })).status === 404 } catch { /* 同上 */ }
    assert('03b 已审批可读(200)，未审批/被拒不可读(404)', pub.status === 200 && pending404 && rejected404, { pubStatus: pub.status, pending404, rejected404 })
  } catch (err) {
    assert('03b 已审批可读(200)，未审批/被拒不可读(404)', false, { error: String(err) })
  }

  try {
    const s = await api('GET', '/api/v1/search?q=deploy', { token: 'token-b', expectStatus: 200 })
    assert('04 检索命中已发布条目', s.json.results?.some((r) => r.id === 'mem-deploy-notes'), { results: s.json.results?.map((r) => `${r.id}(${r.score})`) })
  } catch (err) {
    assert('04 检索命中已发布条目', false, { error: String(err) })
  }

  // ---------- 阶段 4：节点 B oneshot（拉共享 + 手动推 + 冲突） ----------
  section('阶段 4：节点 B oneshot（doctor/pull/push/status/search）')
  const bExit = await runOneshot('node-b')
  let bResult = null
  try {
    bResult = JSON.parse(await fsp.readFile(path.join(DEMO_DIR, 'node-b', 'oneshot-node-b.json'), 'utf8'))
  } catch { /* 读不到在断言里报 */ }
  assert('05 B oneshot 全部指令成功', bExit === 0 && bResult?.ok === true, { exit: bExit, ok: bResult?.ok, errors: bResult?.results?.filter((r) => !r.ok) })

  const pullRes = bResult?.results?.find((r) => r.command === 'pull')?.data
  const pushRes = bResult?.results?.find((r) => r.command === 'push')?.data
  const conflictItem = pushRes?.details?.find((d) => d.id === 'mem-deploy-notes')
  assert('06 推送同 id 不同内容 → conflict(含 serverVersion)，新条目 → queued',
    conflictItem?.status === 'conflict' && conflictItem?.serverVersion === 1 && pushRes?.details?.some((d) => d.id === 'mem-b-local-note' && d.status === 'queued'),
    { conflictItem, pushIds: pushRes?.details?.map((d) => `${d.id}:${d.status}`) })

  const pullSkill = pullRes?.details?.find((d) => d.kind === 'skill' && d.id === 'demo-greet')
  const conflictCopyDir = pullRes?.details?.find((d) => d.id === 'mem-deploy-notes')?.file
  let conflictCopyExists = false
  if (conflictCopyDir) conflictCopyExists = await fsp.stat(conflictCopyDir).then(() => true, () => false)
  assert('07 拉取冲突：B 本地内容保全为冲突副本', conflictCopyExists, { file: conflictCopyDir })

  // B 本地有同 id 不同内容的 deploy-notes（阶段 4 造的冲突），pull 的正确行为是保全冲突副本而非覆盖写 shared/；
  // memory 共享写入由 09b/12 的 runbook 条目验证。这里验证 skill 共享 + 冲突语义。
  const deployDetail = pullRes?.details?.find((d) => d.id === 'mem-deploy-notes')
  const conflictPreserved = deployDetail?.status === 'conflict-copy'
  let sharedSkillOk = false
  try {
    await fsp.access(path.join(DEMO_DIR, 'node-b', 'skills', 'demo-greet', 'SKILL.md'))
    const marker = JSON.parse(await fsp.readFile(path.join(DEMO_DIR, 'node-b', 'skills', 'demo-greet', '.clh-knowledge-sync.json'), 'utf8'))
    sharedSkillOk = marker.source === 'clh-knowledge-sync-hub'
  } catch { /* 未写入 */ }
  assert('09a B 拉到共享 skill(带来源标记)且冲突条目保全为副本', conflictPreserved && sharedSkillOk, { conflictPreserved, sharedSkillOk, deployStatus: deployDetail?.status })
  // pull 的冲突保全语义状态名：conflict-copy（副本路径见 detail.file）

  // 等待 A 的自动轮询回读审批结果
  section('阶段 5：A 回读审批结果（自动循环）')
  try {
    const stateFile = path.join(DEMO_DIR, 'node-a', 'memory', '.clh-knowledge-sync', 'sync-state.json')
    const aState = await waitUntil(async () => {
      try {
        const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
        return raw.pushed?.['mem-project-conventions']?.status === 'rejected' ? raw : null
      } catch { return null }
    }, { what: 'A 读到 rejected 状态', timeoutMs: 20000 })
    const rejectedRec = aState.pushed['mem-project-conventions']
    const approvedRec = aState.pushed['mem-deploy-notes']
    assert('08 A 读到审批结果：被拒带 reason，被批带 version',
      rejectedRec?.status === 'rejected' && String(rejectedRec?.reason ?? '').includes('标题太泛') && approvedRec?.status === 'approved' && approvedRec?.version === 1,
      { rejected: rejectedRec, approved: approvedRec })
  } catch (err) {
    assert('08 A 读到审批结果：被拒带 reason，被批带 version', false, { error: String(err), aLogsTail: aLogs.slice(-8).join('') })
  }

  // ---------- 阶段 6：批准剩余条目 → B 再拉 → 清理流程 → tombstone ----------
  section('阶段 6：批准 Runbook → B 拉到 → 清理(扫描/提议/审批) → B 收到 tombstone 自动删除')
  try {
    await api('POST', '/api/v1/admin/decisions', { token: 'demo-admin-token', body: { queueId: queueIds['memory:mem-runbook-expired'], action: 'approve' }, expectStatus: 200 })
    const bExit2 = await runOneshot('node-b', 'oneshot-node-b-pull2.json', ['pull'])
    const sharedFile = path.join(DEMO_DIR, 'node-b', 'memory', 'shared', 'mem-runbook-expired.md')
    const got = await fsp.readFile(sharedFile, 'utf8').then(() => true, () => false)
    assert('09b 审批后 B 拉到共享记忆 mem-runbook-expired', bExit2 === 0 && got, { bExit2, got })
  } catch (err) {
    assert('09b 审批后 B 拉到共享记忆 mem-runbook-expired', false, { error: String(err) })
  }

  try {
    const scan = await api('GET', '/api/v1/admin/cleanup-candidates?expiredOnly=true', { token: 'demo-admin-token', expectStatus: 200 })
    const has = scan.json.candidates?.some((c) => c.id === 'mem-runbook-expired')
    assert('10 清理扫描发现过期条目', has === true, { candidates: scan.json.candidates?.map((c) => c.id) })

    await api('POST', '/api/v1/admin/cleanup/propose', { token: 'demo-admin-token', body: { ids: [{ kind: 'memory', id: 'mem-runbook-expired' }], reason: '已过期（demo 清理验收）' }, expectStatus: 200 })
    const flagged = await api('GET', '/api/v1/admin/cleanup/flagged', { token: 'demo-admin-token', expectStatus: 200 })
    assert('11a 清理提议已标记（flagged 列表可见）', flagged.json.flagged?.some((f) => f.id === 'mem-runbook-expired'), { flagged: flagged.json.flagged?.map((f) => f.id) })

    await api('POST', '/api/v1/admin/cleanup/decide', { token: 'demo-admin-token', body: { ids: [{ kind: 'memory', id: 'mem-runbook-expired' }], action: 'approve', reason: 'demo 清理审批通过' }, expectStatus: 200 })
    const gone = (await api('GET', '/api/v1/entries/memory/mem-runbook-expired', { token: 'token-b' })).status === 404
    const stats = await api('GET', '/api/v1/admin/stats', { token: 'demo-admin-token', expectStatus: 200 })
    assert('11b 清理审批后条目移出总库(404)并归档', gone && stats.json.archived >= 1, { gone, archived: stats.json.archived })
  } catch (err) {
    assert('11a/b 清理流程', false, { error: String(err) })
  }

  try {
    const bExit3 = await runOneshot('node-b', 'oneshot-node-b-pull3.json', ['pull'])
    const still = await fsp.stat(path.join(DEMO_DIR, 'node-b', 'memory', 'shared', 'mem-runbook-expired.md')).then(() => true, () => false)
    const pull3 = JSON.parse(await fsp.readFile(path.join(DEMO_DIR, 'node-b', 'oneshot-node-b-pull3.json'), 'utf8'))
    const tombDetail = pull3.results?.find((r) => r.command === 'pull')?.data?.details?.find((d) => d.id === 'mem-runbook-expired')
    assert('12 B 收到 tombstone 并删除本地共享副本', bExit3 === 0 && !still && tombDetail?.status === 'removed', { bExit3, still, tombDetail })
  } catch (err) {
    assert('12 B 收到 tombstone 并删除本地共享副本', false, { error: String(err) })
  }

  // ---------- 阶段 7：节点 C 连接失败 ----------
  section('阶段 7：节点 C 指向不可达端口（异常处理验收）')
  const cExit = await runOneshot('node-c')
  let cResult = null
  try { cResult = JSON.parse(await fsp.readFile(path.join(DEMO_DIR, 'node-c', 'oneshot-node-c.json'), 'utf8')) } catch { /* 读不到在断言里报 */ }
  const cDataErr = cResult?.results?.[0]?.data?.error
  assert('13 C 连接失败明确报错（connect-failed，退出码 1）', cExit === 1 && cResult?.ok === false && cDataErr?.code === 'connect-failed', { exit: cExit, err: cDataErr })

  // ---------- 阶段 8：审计与 admin CLI ----------
  section('阶段 8：审计日志与 admin CLI')
  try {
    const audit = await fsp.readFile(path.join(DEMO_DIR, 'hub-data', 'state', 'audit.jsonl'), 'utf8')
    const hasApprove = audit.includes('"op":"approve"')
    const hasReject = audit.includes('"op":"reject"')
    const hasCleanup = audit.includes('"op":"cleanup-approve"') && audit.includes('"op":"cleanup-propose"')
    assert('14 审计日志记录 approve/reject/cleanup 全过程', hasApprove && hasReject && hasCleanup, { hasApprove, hasReject, hasCleanup })
  } catch (err) {
    assert('14 审计日志记录 approve/reject/cleanup 全过程', false, { error: String(err) })
  }

  try {
    const cli = spawnSync(process.execPath, [path.join(PKG_DIR, 'bin', 'clh-knowledge-sync.js'), 'admin', '--hub-config', path.join(DEMO_DIR, 'hub.config.json'), 'stats'], { encoding: 'utf8' })
    const ok = cli.status === 0 && cli.stdout.includes('"pending"')
    assert('15 admin CLI stats 可用', ok, { status: cli.status, stdout: cli.stdout.slice(0, 160), stderr: cli.stderr.slice(0, 160) })
  } catch (err) {
    assert('15 admin CLI stats 可用', false, { error: String(err) })
  }

  aProc.kill()
  hubProc.kill()
  return finish(hubLogs)
}

async function runOneshot(node, resultName, commands) {
  const cwd = path.join(DEMO_DIR, node)
  const token = node === 'node-b' ? 'token-b' : 'token-c'
  const port = node === 'node-b' ? HUB_PORT : BAD_PORT
  const oneshot = commands
    ? { enabled: true, commands, resultFile: `./${resultName}` }
    : { enabled: true, commands: ['doctor', 'pull', 'push', 'status', 'search deploy'], resultFile: `./oneshot-${node}.json` }
  // 启动器固定读取 ./cordis.yml：oneshot 重跑时直接重写该文件（此时上一进程已退出）
  await write(path.join(cwd, 'cordis.yml'), yamlNodeConfig(node, token, port, { auto: false, oneshot }))
  const proc = spawn(process.execPath, [CORDIS_BIN], { cwd })
  let exit = null
  const logs = []
  proc.stdout.on('data', (d) => logs.push(d.toString()))
  proc.stderr.on('data', (d) => logs.push(d.toString()))
  proc.on('exit', (code) => { exit = code })
  await waitUntil(async () => exit !== null, { what: `${node} oneshot 退出`, timeoutMs: 60000, every: 200 })
  oneshotLogs[node] = logs.join('')
  return exit
}

const oneshotLogs = {}

function finish(hubLogs) {
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== 结果: ${passed}/${results.length} PASS =====`)
  for (const f of failed) console.log(`  FAIL ${f.name}`)
  if (failed.length === 0) console.log('\n全部断言通过：连接→自动/手动同步→跨节点读取→未审批不进总库→审批后清理→tombstone 下发→连接失败明确报错。')
  else {
    console.log('\nhub 日志尾部：')
    console.log(hubLogs.slice(-8).join(''))
    for (const [node, log] of Object.entries(oneshotLogs)) {
      if (log) console.log(`\n${node} 日志尾部：\n${log.slice(-1200)}`)
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('demo 异常终止:', err)
  process.exitCode = 1
})
