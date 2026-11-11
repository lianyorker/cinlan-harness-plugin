#!/usr/bin/env node
/** 节点/管理 CLI 入口。用法见 `clh-knowledge-sync help`。 */
import { runNodeCli } from '../lib/hub/cli.js'

process.exitCode = await runNodeCli(process.argv.slice(2))
