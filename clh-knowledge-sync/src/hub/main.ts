/**
 * hub 独立进程入口（bin/hub.js 调用），也可被程序化引用：
 *   import { loadHubConfig, startHub } from '@cinlan/clh-knowledge-sync/hub'
 * 启动失败（配置错、端口占用、证书缺失）都打印明确错误并以非零码退出。
 */
import path from 'node:path'
import { createLogger, ensureLogDir, logFilePathFor } from '../logger.js'
import { loadHubConfig, type HubConfig } from '../config.js'
import { SyncError } from '../util.js'
import { startHubServer, type HubRuntime } from './server.js'

export async function startHub(cfg: HubConfig): Promise<HubRuntime> {
  const logDir = cfg.log.dir ? path.resolve(cfg.log.dir) : path.join(cfg.dataDir, 'logs')
  await ensureLogDir(logDir)
  const logger = createLogger({
    component: 'hub',
    level: cfg.log.level as 'debug' | 'info' | 'warn' | 'error',
    filePath: logFilePathFor(logDir, 'hub'),
  })
  const runtime = await startHubServer(cfg, logger)
  logger.info('hub-started', `hub 已监听 ${cfg.listen.protocol}://${cfg.listen.host}:${runtime.port}`, {
    dataDir: cfg.dataDir,
    nodes: Object.keys(cfg.auth.nodeTokens).join(','),
  })
  return runtime
}

export async function runHubCli(argv: string[]): Promise<number> {
  let configFile = 'hub.config.json'
  let portOverride: number | undefined
  const args = [...argv]
  while (args.length) {
    const a = args.shift()!
    if (a === '--config') configFile = args.shift()!
    else if (a === '--port') portOverride = Number.parseInt(args.shift()!, 10)
    else if (a === '--help' || a === '-h') {
      printUsage()
      return 0
    } else {
      console.error(`未知参数: ${a}`)
      printUsage()
      return 2
    }
  }
  try {
    const cfg = await loadHubConfig(path.resolve(configFile), { port: portOverride })
    const runtime = await startHub(cfg)
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\nhub 收到 ${signal}，正在关闭…`)
      await runtime.close()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    return 0
  } catch (err) {
    if (err instanceof SyncError) {
      console.error(`[hub] 启动失败: ${err.code}: ${err.message}`)
    } else {
      console.error(`[hub] 启动失败: ${(err as Error).message}`)
    }
    return 1
  }
}

function printUsage(): void {
  console.log(`用法: clh-knowledge-sync-hub --config <hub.config.json> [--port <port>]

hub 配置示例见 config/hub.example.json：
  - listen.protocol = http（内网）| https（外网，需 tls.certFile/keyFile）
  - auth.adminToken / auth.nodeTokens 支持 "\${ENV_VAR}" 从环境变量注入
`)
}
