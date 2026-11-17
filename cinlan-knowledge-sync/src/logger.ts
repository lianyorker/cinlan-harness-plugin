/**
 * 结构化日志：控制台一行可读 + JSONL 文件可检索。
 * 日志自身写失败只降级到 stderr 提醒一次，绝不吞掉业务错误。
 */
import { appendFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { nowIso } from './util.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LogFields {
  [key: string]: unknown
}

export interface Logger {
  debug(event: string, message: string, data?: LogFields): void
  info(event: string, message: string, data?: LogFields): void
  warn(event: string, message: string, data?: LogFields): void
  error(event: string, message: string, data?: LogFields): void
  close(): void
}

export interface LoggerOptions {
  component: string
  level?: LogLevel
  /** JSONL 文件路径；缺省只写控制台 */
  filePath?: string
  /** 关闭控制台输出（demo 断言时避免刷屏） */
  quiet?: boolean
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? 'info'
  const fileWarned = { done: false }
  // 日志目录同步建立：首条日志写入时目录必须已存在（异步会竞态）
  if (opts.filePath) {
    try {
      mkdirSync(path.dirname(opts.filePath), { recursive: true })
    } catch { /* 已存在或并发建立 */ }
  }

  const write = (lvl: LogLevel, event: string, message: string, data?: LogFields): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return
    const record = { ts: nowIso(), level: lvl, component: opts.component, event, message, ...data }
    if (!opts.quiet) {
      const line = `[${record.ts}] ${lvl.toUpperCase().padEnd(5)} [${opts.component}] ${event}: ${message}`
      const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''
      const sink = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log
      sink(`${line}${extra}`)
    }
    if (opts.filePath) {
      appendFile(opts.filePath, JSON.stringify(record) + '\n', 'utf8').catch((err) => {
        if (!fileWarned.done) {
          fileWarned.done = true
          console.error(`[logger] 日志文件写入失败（后续不再提醒）: ${opts.filePath}: ${(err as Error).message}`)
        }
      })
    }
  }

  return {
    debug: (e, m, d) => write('debug', e, m, d),
    info: (e, m, d) => write('info', e, m, d),
    warn: (e, m, d) => write('warn', e, m, d),
    error: (e, m, d) => write('error', e, m, d),
    close: () => {},
  }
}

/** 生成按日期滚动的日志文件路径：<dir>/<name>-YYYYMMDD.log */
export function logFilePathFor(dir: string, name: string, date = new Date()): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  return path.join(dir, `${name}-${ymd}.log`)
}

export async function ensureLogDir(dir: string): Promise<void> {
  if (dir) await mkdirSync(dir, { recursive: true })
}
