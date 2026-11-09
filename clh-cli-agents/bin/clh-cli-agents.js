#!/usr/bin/env node
// clh-cli-agents CLI 入口：脱离 harness 直接驱动已配置的外部 CLI agent。
// 用法见 ../src/cli.ts（list / detect / run）。
import { main } from '../lib/cli.js'

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
