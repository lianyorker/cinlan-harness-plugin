#!/usr/bin/env node
/** hub 独立进程入口。用法: cinlan-knowledge-sync-hub --config hub.config.json [--port N] */
import { runHubCli } from '../lib/hub/main.js'

process.exitCode = await runHubCli(process.argv.slice(2))
