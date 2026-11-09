#!/usr/bin/env node
// e2e stub：模拟 headless CLI agent 的行为面（argv 旗标、stdin 注入、JSON 输出、
// 可注入延迟），供 demo/e2e-demo.mjs 在不依赖真 claude/codex 的机器上做断言。
// 解析规则：-- 之后的参数都是 prompt（argv 模式）；--prefill X 是 flag-prompt 模式；
// 两者都没有时读全部 stdin（stdin-after-start 模式）。
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)

function take(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

if (argv.includes('--version')) {
  console.log('stub-agent 1.2.3')
  process.exit(0)
}

const sleepMs = Number(take('--sleep-ms') ?? 0)
const fmt = take('--output-format')
const prefill = take('--prefill')
const sepIdx = argv.indexOf('--')
let prompt = sepIdx >= 0 ? argv.slice(sepIdx + 1).join(' ') : (prefill ?? '')
if (!prompt && sepIdx < 0 && prefill === undefined) {
  prompt = readFileSync(0, 'utf8')
}
const started = Date.now()

const finish = () => {
  const payload = {
    result: prompt,
    cwd: process.cwd(),
    stubToken: process.env.STUB_TOKEN ?? null,
    startedAt: started,
    elapsedMs: Date.now() - started,
  }
  if (fmt === 'json') console.log(JSON.stringify(payload))
  else console.log(prompt)
  process.exit(0)
}

if (sleepMs > 0) setTimeout(finish, sleepMs)
else finish()
