#!/usr/bin/env node
/**
 * clh-cli-agents 端到端验收。
 *
 * A 部分（同进程）：真实 cordis 挂载插件 + AgentRuntime 驱动 demo/fake-agents 的 stub
 * （不依赖真 claude/codex），覆盖配置校验、三种 prompt 注入、JSON 解析、超时、失败、
 * 并发排队、cwd/env、工具行、CLI。
 * B 部分（跨进程）：vendor/cordis 的真实 loader 按 cordis.yml 挂载本插件（node-real），
 * 以及坏配置在 loader 侧报错的可见性（node-bad）。
 *
 * stub 路径相对插件根解析 → 本脚本及 CLI 断言都以插件根为 cwd（package.json 的 e2e script 保证）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url))
const HARNESS_DIR = path.resolve(PKG_DIR, '..', '..', 'cinlan-harness')
const CORDIS_BIN = path.join(HARNESS_DIR, 'vendor', 'cordis', 'bin.js')

const results = []
function assert(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
}
function section(title) {
  console.log(`\n===== ${title} =====`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn, { timeoutMs = 20000, every = 200, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  throw new Error(`等待超时(${timeoutMs}ms): ${what}，最后值=${JSON.stringify(last)?.slice(0, 200)}`)
}

async function ensureJunction(link, target) {
  await fsp.rm(link, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(link), { recursive: true })
  await fsp.symlink(target, link, 'junction')
}

async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
}

/** demo 用的绝对路径（正斜杠、无引号——demo 路径无空格；cmd.exe 的 shell 不认单引号）。 */
const posix = (p) => path.resolve(p).replace(/\\/g, '/')

const yamlPath = posix

const ECHO_STUB = path.join(DEMO_DIR, 'fake-agents', 'echo-agent.mjs')
const FAIL_STUB = path.join(DEMO_DIR, 'fake-agents', 'fail-agent.mjs')

async function main() {
  console.log('clh-cli-agents e2e demo')
  console.log(`包目录: ${PKG_DIR}`)

  // ---------- 准备：peer junction + demo 配置 ----------
  section('准备：junction 与配置')
  const peerTargets = {
    '@deepseek-ai/cordis': path.join(HARNESS_DIR, 'vendor', 'cordis'),
    '@deepseek-ai/schemastery': path.join(HARNESS_DIR, 'vendor', 'schemastery'),
    '@deepseek-ai/dsh-tools': path.join(HARNESS_DIR, 'packages', 'core', 'tools'),
  }
  for (const [pkg, target] of Object.entries(peerTargets)) {
    await ensureJunction(path.join(PKG_DIR, 'node_modules', pkg), target)
  }
  const { resolveConfig, ConfigError, CliAgentError } = await import('../lib/config.js')
  const { AgentRuntime, buildArgv, extractJson } = await import('../lib/runtime.js')
  const pluginIndex = await import('../lib/index.js')
  const pluginTools = await import('../lib/tools.js')
  const { Context } = await import('@deepseek-ai/cordis')
  console.log('peer junction 就绪，lib 已加载')

  // ---------- 01 配置校验聚合 ----------
  section('A1 配置校验')
  const badRaw = {
    agents: {
      'ok-id': { command: 'node' },
      'bad id!': { command: 'node' },
      typo: { command: 'node', notAField: 1 },
      fp: { command: 'node', promptInjectionMode: 'flag-prompt' },
      acp: { command: 'node', protocol: 'acp' },
      missenv: { command: 'node', env: { X: '${CLH_E2E_MISSING_ENV_XYZ}' } },
    },
  }
  try {
    resolveConfig(badRaw, PKG_DIR)
    assert('01 坏配置聚合报错', false, { error: '未抛出 ConfigError' })
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : ''
    const has = (s) => msg.includes(s)
    assert('01 坏配置聚合报错（未知字段/坏 id/缺 promptFlag/acp 未实现/缺 env）',
      err instanceof ConfigError && has('notAField') && has('bad id!') && has('promptFlag') && has('acp') && has('CLH_E2E_MISSING_ENV_XYZ'),
      { message: msg })
  }

  // ---------- 02 服务挂载（真实 cordis） ----------
  section('A2 服务挂载与探测')
  const demoRaw = JSON.parse(await fsp.readFile(path.join(DEMO_DIR, 'config.json'), 'utf8'))
  // A 部分用 args 绝对化后的配置：04d 会把 spawn cwd 指到别处，相对 stub 路径会断。
  // CLI 断言（05x）用文件原样相对路径（cwd=PKG_DIR 时成立），正好测两种写法。
  const absRaw = JSON.parse(JSON.stringify(demoRaw))
  for (const a of Object.values(absRaw.agents)) {
    a.args = (a.args ?? []).map((x) => (x.startsWith('./demo/') ? posix(path.join(PKG_DIR, x)) : x))
  }
  const resolved = resolveConfig(absRaw, PKG_DIR)
  assert('02a resolveConfig 正常路径（10 agent、超时默认 600000）', resolved.agents.size === 10 && resolved.agents.get('echo').timeoutMs === 600000, { size: resolved.agents.size })

  const ctx = new Context()
  // 与真实 loader 一致：传原始配置对象（apply → resolveConfig），不是已解析结果
  ctx.plugin(pluginIndex, absRaw)
  await sleep(300) // 等 Service.init（detectOnStart 探测全部 stub）落定
  const service = ctx.clhCliAgents
  assert('02b ctx.clhCliAgents 挂载且 agentIds 齐全',
    Boolean(service) && JSON.stringify(service.agentIds.slice().sort()) === JSON.stringify(['badjson', 'echo', 'echo-text', 'fail', 'ghost', 'promptflag', 'queue', 'slow', 'stdin', 'withenv']),
    { agentIds: service?.agentIds })
  assert('02c state() 汇总', service.state().agents.length === 10 && service.state().running === 0, { state: service.state() })

  const detects = await service.detectAll()
  const echoDetect = detects.find((d) => d.agent === 'echo')
  const ghostDetect = detects.find((d) => d.agent === 'ghost')
  assert('02d 探测：stub 就绪且读出版本行', echoDetect?.installed === true && echoDetect.version === 'stub-agent 1.2.3', { echoDetect })
  assert('02e 探测：不在 PATH 的命令报不在位（command-not-found）', ghostDetect?.installed === false && String(ghostDetect.error).includes('command-not-found'), { ghostDetect })

  // ---------- 03 三种 prompt 注入 ----------
  section('A3 prompt 注入（orca 语义）')
  const r1 = await service.run('echo', 'e2e hello')
  assert('03a argv 注入（-- 分隔）', r1.ok === true && r1.parsed?.result === 'e2e hello', { result: r1.parsed?.result, argv: r1.argv })
  const r2 = await service.run('promptflag', 'flag-prompt body')
  assert('03b flag-prompt 注入', r2.ok === true && r2.parsed?.result === 'flag-prompt body', { result: r2.parsed?.result, argv: r2.argv })
  const r3 = await service.run('stdin', 'stdin body')
  assert('03c stdin-after-start 注入', r3.ok === true && r3.parsed?.result === 'stdin body', { result: r3.parsed?.result })

  const rt = await service.run('echo-text', 'plain text body')
  assert('03d text 输出不做 JSON 解析', rt.ok === true && rt.stdout.trim() === 'plain text body' && rt.parsed === undefined, { stdout: rt.stdout.trim(), parsed: rt.parsed })
  const rb = await service.run('badjson', 'x')
  assert('03e outputFormat=json 但 stdout 非 JSON → parseFailed', rb.ok === false && rb.exitCode === 3 && rb.parseFailed === true, { ok: rb.ok, exitCode: rb.exitCode, parseFailed: rb.parseFailed })

  // ---------- 04 超时 / 失败 / 排队 / cwd / env ----------
  section('A4 运行语义')
  const slowStart = Date.now()
  const rSlow = await service.run('slow', 'timeout case', { timeoutMs: 800 })
  assert('04a 超时：timedOut 标记且及时终止', rSlow.timedOut === true && rSlow.ok === false && Date.now() - slowStart < 4000, { duration: Date.now() - slowStart, error: rSlow.error })
  const rFail = await service.run('fail', 'x')
  assert('04b 失败传播：exitCode 3、stderr 保留', rFail.ok === false && rFail.exitCode === 3 && rFail.stderr.includes('boom'), { stderr: rFail.stderr })

  // 并发上限的可见效果是两次运行串行（各自 ~1.2s，总耗时 ≳ 2.2s）；
  // durationMs 只含纯运行时长（不含排队），用它比大小会测错对象
  const queueStart = Date.now()
  const [q1, q2] = await Promise.all([service.run('queue', 'first'), service.run('queue', 'second')])
  const queueTotal = Date.now() - queueStart
  assert('04c maxConcurrent=1 串行：总耗时 ≳ 两次运行之和', queueTotal >= 2200 && q1.ok && q2.ok, { total: queueTotal, d1: q1.durationMs, d2: q2.durationMs })

  const tmpCwd = await fsp.mkdtemp(path.join(DEMO_DIR, 'cwd-'))
  try {
    const rc = await service.run('echo', 'cwd case', { cwd: tmpCwd })
    assert('04d cwd 覆盖生效', rc.parsed?.cwd === path.resolve(tmpCwd), { got: rc.parsed?.cwd, want: path.resolve(tmpCwd) })
  } finally {
    await fsp.rm(tmpCwd, { recursive: true, force: true })
  }
  const re = await service.run('withenv', 'env case')
  assert('04e env 注入（含 ${ENV} 解析后的值）', re.parsed?.stubToken === 'e2e-secret', { stubToken: re.parsed?.stubToken })

  await service.run('nope', 'x').then(() => assert('04f 未知 agent 报 unknown-agent', false, { error: '未抛错' }), (err) => assert('04f 未知 agent 报 unknown-agent', err instanceof CliAgentError && String(err.message).includes('unknown-agent'), { message: err.message }))
  await service.run('echo', '   ').then(() => assert('04g 空 prompt 报 invalid-prompt', false, { error: '未抛错' }), (err) => assert('04g 空 prompt 报 invalid-prompt', err instanceof CliAgentError && String(err.message).includes('invalid-prompt'), { message: err.message }))

  // buildArgv / extractJson 纯函数直测（stderr 场景、子串提取）
  const echoAgent = resolved.agents.get('echo')
  const argvBuilt = buildArgv(echoAgent, 'P')
  assert('04h buildArgv：argv+分隔符把 prompt 放最后', argvBuilt.at(-1) === 'P' && argvBuilt.at(-2) === '--' && argvBuilt.at(-3) === 'json', { argv: argvBuilt })
  assert('04i extractJson：噪声里取 JSON 子串', extractJson('prefix noise\n{"a":1}\ntrailing').value?.a === 1, { got: extractJson('prefix noise\n{"a":1}\ntrailing').value })

  // ---------- 05 独立 CLI ----------
  section('A5 CLI')
  const cliRun = spawnSync(process.execPath, ['bin/clh-cli-agents.js', '--config', 'demo/config.json', 'run', 'echo', 'cli hello'], { cwd: PKG_DIR, encoding: 'utf8', timeout: 30000 })
  let cliParsed = null
  try { cliParsed = JSON.parse(cliRun.stdout) } catch { /* 解析失败在断言里报 */ }
  // CLI 输出的是 RunResult；stub 的回显在 RunResult.stdout（JSON 字符串）里
  let cliEcho = null
  try { cliEcho = JSON.parse(cliParsed?.stdout ?? '') } catch { /* 同上 */ }
  assert('05a CLI run：退出码 0 + JSON 结果', cliRun.status === 0 && cliEcho?.result === 'cli hello', { status: cliRun.status, echo: cliEcho, stderr: cliRun.stderr.slice(0, 120) })
  const cliDetect = spawnSync(process.execPath, ['bin/clh-cli-agents.js', '--config', 'demo/config.json', 'detect', 'echo'], { cwd: PKG_DIR, encoding: 'utf8', timeout: 30000 })
  assert('05b CLI detect：exit 0 且 installed=true', cliDetect.status === 0 && JSON.parse(cliDetect.stdout)[0]?.installed === true, { status: cliDetect.status, stdout: cliDetect.stdout.slice(0, 120) })
  const cliFail = spawnSync(process.execPath, ['bin/clh-cli-agents.js', '--config', 'demo/config.json', 'run', 'fail', 'x'], { cwd: PKG_DIR, encoding: 'utf8', timeout: 30000 })
  assert('05c CLI run 失败透传退出码 3', cliFail.status === 3, { status: cliFail.status })
  const cliBad = spawnSync(process.execPath, ['bin/clh-cli-agents.js', '--config', 'demo/config.json', 'run', 'nope', 'x'], { cwd: PKG_DIR, encoding: 'utf8', timeout: 30000 })
  assert('05d CLI 未知 agent → 退出码 2 + 错误文本', cliBad.status === 2 && cliBad.stderr.includes('unknown-agent'), { status: cliBad.status, stderr: cliBad.stderr.slice(0, 160) })

  // ---------- 06 工具行 ----------
  section('A6 模型工具行')
  const registered = []
  const stubToolsCtx = { tools: { register: (t) => registered.push(t) }, get: (name) => (name === 'clhCliAgents' ? service : undefined) }
  pluginTools.apply(stubToolsCtx)
  assert('06a 注册两个工具', registered.length === 2 && registered.map((t) => t.name).sort().join(',') === 'cli_agent_run,cli_agents_list', { names: registered.map((t) => t.name) })
  const listTool = registered.find((t) => t.name === 'cli_agents_list')
  const runTool = registered.find((t) => t.name === 'cli_agent_run')
  const listOut = await listTool.execute({})
  assert('06b cli_agents_list：列出全部且标注就绪/不在位', listOut.includes('echo') && listOut.includes('就绪') && listOut.includes('不在位'), { sample: String(listOut).slice(0, 160) })
  const runOut = await runTool.execute({ agent: 'echo', prompt: 'tool body' })
  assert('06c cli_agent_run：返回渲染结果', String(runOut).includes('ok: true') && String(runOut).includes('tool body'), { sample: String(runOut).slice(0, 160) })
  const longRender = pluginTools.renderRunResult({ agent: 'echo', ok: true, exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdout: 'x'.repeat(6000), stderr: '', truncated: false, argv: [], cwd: '.' })
  assert('06d renderRunResult：超长 stdout 截断并标注', longRender.includes('截断') && longRender.length < 6000, { len: longRender.length })

  // ---------- 07 独立 runtime dispose ----------
  section('A7 资源释放')
  const runtime2 = new AgentRuntime(resolveConfig({ agents: { slow: demoRaw.agents.slow } }, PKG_DIR), { info() {}, warn() {}, debug() {}, error() {} })
  const p = runtime2.run('slow', 'dispose case', { timeoutMs: 9000 })
  await sleep(300)
  await runtime2.dispose()
  const disposed = await p.then((r) => r, (err) => ({ error: String(err) }))
  assert('07 dispose 终止运行中进程并落定', (disposed.timedOut === true || disposed.signal != null) && runtime2.runningCount() === 0, { disposed: { timedOut: disposed.timedOut, signal: disposed.signal } })

  // ---------- B 真实 loader ----------
  section('B 真实 cordis loader 挂载')
  const nodeReal = path.join(DEMO_DIR, 'node-real')
  await write(path.join(nodeReal, 'package.json'), JSON.stringify({ name: '@demo/node-real', private: true, type: 'module' }, null, 2))
  await ensureJunction(path.join(nodeReal, 'node_modules', '@cinlan', 'clh-cli-agents'), PKG_DIR)
  await ensureJunction(path.join(nodeReal, 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), path.join(HARNESS_DIR, 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'))
  await ensureJunction(path.join(nodeReal, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'), path.join(HARNESS_DIR, 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'))
  await write(path.join(nodeReal, 'cordis.yml'), [
    `- name: '@cinlan/clh-cli-agents'`,
    `  config:`,
    `    agents:`,
    `      echo:`,
    `        command: node`,
    `        args:`,
    `          - ${yamlPath(ECHO_STUB)}`,
    `        promptInjectionMode: argv`,
    `        argvSeparator: '--'`,
    `        outputFormat: json`,
    `        detect: node ${yamlPath(ECHO_STUB)} --version`,
    `    detectOnStart: true`,
    `    log:`,
    `      level: info`,
    '',
  ].join('\n'))

  const realLogs = []
  const realProc = spawn(process.execPath, [CORDIS_BIN], { cwd: nodeReal })
  realProc.stdout.on('data', (d) => realLogs.push(d.toString()))
  realProc.stderr.on('data', (d) => realLogs.push(d.toString()))
  try {
    const logs = await waitUntil(() => (realLogs.join('').includes('agent-detect-ok') ? realLogs.join('') : null), { what: 'loader 挂载并完成探测', timeoutMs: 30000 })
    assert('08a 真实 loader：服务创建并探测 stub 成功', logs.includes('"event":"service-created"') && logs.includes('"event":"agent-detect-ok"'), { hasCreated: logs.includes('service-created') })
  } catch (err) {
    assert('08a 真实 loader：服务创建并探测 stub 成功', false, { error: String(err), logsTail: realLogs.join('').slice(-1200) })
  } finally {
    realProc.kill()
  }

  const nodeBad = path.join(DEMO_DIR, 'node-bad')
  await write(path.join(nodeBad, 'package.json'), JSON.stringify({ name: '@demo/node-bad', private: true, type: 'module' }, null, 2))
  await ensureJunction(path.join(nodeBad, 'node_modules', '@cinlan', 'clh-cli-agents'), PKG_DIR)
  await ensureJunction(path.join(nodeBad, 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), path.join(HARNESS_DIR, 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'))
  await ensureJunction(path.join(nodeBad, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'), path.join(HARNESS_DIR, 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'))
  await write(path.join(nodeBad, 'cordis.yml'), [
    `- name: '@cinlan/clh-cli-agents'`,
    `  config:`,
    `    agents:`,
    `      fp:`,
    `        command: node`,
    `        args:`,
    `          - ${yamlPath(ECHO_STUB)}`,
    `        promptInjectionMode: flag-prompt`,
    '',
  ].join('\n'))
  const badLogs = []
  // cordis 默认 logger 只写内存 buffer 不打终端，真实 bin.js 下坏配置静默；
  // boot-check.mjs 挂 console exporter 后走同一加载链，让报错内容可见（README 已注明此差异）
  await fsp.copyFile(path.join(DEMO_DIR, 'boot-check.mjs'), path.join(nodeBad, 'boot-check.mjs'))
  const badProc = spawn(process.execPath, [path.join(nodeBad, 'boot-check.mjs')], { cwd: nodeBad })
  badProc.stdout.on('data', (d) => badLogs.push(d.toString()))
  badProc.stderr.on('data', (d) => badLogs.push(d.toString()))
  try {
    const logs = await waitUntil(() => (badLogs.join('').includes('promptFlag') ? badLogs.join('') : null), { what: '坏配置在 loader 侧报错', timeoutMs: 30000 })
    assert('08b 真实 loader：缺 promptFlag 的配置明确报错', logs.includes('agents.fp.promptFlag') && logs.includes('flag-prompt'), { logSample: logs.split('\n').find((l) => l.includes('promptFlag'))?.slice(0, 260) })
  } catch (err) {
    assert('08b 真实 loader：缺 promptFlag 的配置明确报错', false, { error: String(err), logsTail: badLogs.join('').slice(-1200) })
  } finally {
    badProc.kill()
  }

  return finish()
}

function finish() {
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== 结果: ${passed}/${results.length} PASS =====`)
  for (const f of failed) console.log(`  FAIL ${f.name}`)
  if (failed.length === 0) {
    console.log('\n全部断言通过：配置校验聚合 → 服务挂载/探测 → 三种注入 → 超时/失败/排队/cwd/env → CLI → 工具行 → dispose → 真实 loader 挂载与坏配置报错。')
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('demo 异常终止:', err)
  process.exitCode = 1
})
