/**
 * clh-cli-agents 独立 CLI：脱离 harness 直接驱动已配置的外部 CLI agent。
 *
 * 用途：手动验收（探测真机 claude/codex）、e2e 断言、脚本化调用。
 * 配置是 JSON 文件（结构同 cordis config 的 agents/log 块），resolveConfig 与插件共用同一条校验路径。
 *
 * 退出码：run 透传 agent 退出码（null/信号 → 1，超时 → 124，GNU timeout 惯例）；
 * 配置/用法错误 → 2。
 */
import { promises as fsp } from 'node:fs'
import { resolveConfig, type CliAgentsConfigInput } from './config.js'
import { createLogger } from './logger.js'
import { AgentRuntime } from './runtime.js'

function usage(): string {
  return [
    '用法: clh-cli-agents [--config <file>] <command>',
    '',
    'commands:',
    '  list                  列出已配置 agent（id / 注入方式 / 命令 / 描述）',
    '  detect [id...]        探测 agent 是否在位（缺省 = 全部）',
    '  run <id> <prompt...>  派发一次性任务并等待完成（输出 JSON 结果）',
    '',
    'options:',
    '  --config <file>  配置文件路径（默认 ./clh-cli-agents.config.json）',
  ].join('\n')
}

function exitCodeFor(exitCode: number | null, timedOut: boolean): number {
  if (timedOut) return 124
  if (exitCode === null) return 1
  return exitCode
}

export async function main(argv: string[]): Promise<number> {
  let configPath = './clh-cli-agents.config.json'
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--config') {
      configPath = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      return 0
    } else {
      rest.push(arg)
    }
  }
  const [cmd, id, ...promptParts] = rest
  if (!cmd) {
    console.error(usage())
    return 2
  }
  if (!configPath) {
    console.error('错误: --config 需要一个文件路径')
    return 2
  }

  let raw: CliAgentsConfigInput
  try {
    raw = JSON.parse(await fsp.readFile(configPath, 'utf8')) as CliAgentsConfigInput
  } catch (err) {
    console.error(`错误: 配置文件读取失败（${configPath}）: ${(err as Error).message}`)
    return 2
  }

  let resolved
  try {
    resolved = resolveConfig(raw ?? {}, process.cwd())
  } catch (err) {
    console.error((err as Error).message)
    return 2
  }

  const logger = createLogger({ component: 'clh-cli-agents-cli', level: resolved.logLevel, channel: 'stderr' })
  const runtime = new AgentRuntime(resolved, logger)
  try {
    switch (cmd) {
      case 'list': {
        for (const a of resolved.agents.values()) {
          console.log(`${a.id}\t${a.promptInjectionMode}\t${a.command}${a.description ? `\t${a.description}` : ''}`)
        }
        return 0
      }
      case 'detect': {
        const ids = id ? [id, ...promptParts] : [...resolved.agents.keys()]
        const results = await Promise.all(ids.map((x) => runtime.detect(x)))
        console.log(JSON.stringify(results, null, 2))
        return results.every((r) => r.installed) ? 0 : 1
      }
      case 'run': {
        if (!id || promptParts.length === 0) {
          console.error('错误: run 需要 agent id 与 prompt（如 run echo "hello"）')
          return 2
        }
        const result = await runtime.run(id, promptParts.join(' '))
        console.log(JSON.stringify(result, null, 2))
        return exitCodeFor(result.exitCode, result.timedOut)
      }
      default:
        console.error(`未知命令: ${cmd}\n\n${usage()}`)
        return 2
    }
  } catch (err) {
    console.error(`错误: ${(err as Error).message}`)
    return 2
  } finally {
    await runtime.dispose()
  }
}
