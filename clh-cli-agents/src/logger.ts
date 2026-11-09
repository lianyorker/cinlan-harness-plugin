/**
 * @cinlan/clh-cli-agents 日志层。
 *
 * 独立精简实现（不复用 knowledge-sync 的 logger）：本插件日志量小、无轮转需求，
 * 只需要「console 输出 + 可选 JSONL 落盘」两条通道，供 e2e 抓日志断言与事后审计。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  readonly level: LogLevel
  debug(event: string, message: string, data?: unknown): void
  info(event: string, message: string, data?: unknown): void
  warn(event: string, message: string, data?: unknown): void
  error(event: string, message: string, data?: unknown): void
}

export interface LoggerOptions {
  component: string
  level: LogLevel
  /** 给了就向该文件追加 JSONL（目录不存在会自动创建）；写失败只吞掉，不影响主流程。 */
  filePath?: string
  /** 输出通道：stdout（默认，harness 抓插件日志）或 stderr（CLI：结果走 stdout、日志走 stderr） */
  channel?: 'stdout' | 'stderr'
}

export async function ensureLogDir(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
}

export function logFilePathFor(dir: string, name: string): string {
  return path.join(dir, `${name}.jsonl`)
}

export function createLogger(options: LoggerOptions): Logger {
  const min = LEVEL_VALUE[options.level]
  const emit = options.channel === 'stderr' ? console.error : console.log
  const write = (level: LogLevel, event: string, message: string, data?: unknown): void => {
    if (LEVEL_VALUE[level] < min) return
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      component: options.component,
      event,
      message,
      ...(data === undefined ? {} : { data }),
    })
    // eslint-disable-next-line no-console -- 插件侧无宿主日志 API，console 是双运行时通用的输出通道
    emit(line)
    if (options.filePath) {
      void fsp.appendFile(options.filePath, line + '\n', 'utf8').catch(() => { /* 日志失败不干扰主流程 */ })
    }
  }
  return {
    level: options.level,
    debug: (e, m, d) => write('debug', e, m, d),
    info: (e, m, d) => write('info', e, m, d),
    warn: (e, m, d) => write('warn', e, m, d),
    error: (e, m, d) => write('error', e, m, d),
  }
}
