/**
 * @cinlan/clh-cli-agents 配置层。
 *
 * 参照 stablyai/orca 的 TUI_AGENT_CONFIG：每个外部 CLI agent 用一条声明式条目描述
 * （探测命令、启动命令、prompt 注入方式、并发上限），插件本体不写死任何 agent——
 * 新增 claude / codex / orca 等只改配置，不改代码。
 *
 * 校验规则：一次性列出全部问题再抛 ConfigError（不静默失败、不逐个试错）；
 * resolveConfig 不经过 Schemastery 也能工作（CLI 从 JSON 文件读配置走同一条路）。
 */
import Schema from '@deepseek-ai/schemastery'
import path from 'node:path'
import type { LogLevel } from './logger.js'

export const PROMPT_INJECTION_MODES = ['argv', 'flag-prompt', 'stdin-after-start'] as const
export type PromptInjectionMode = (typeof PROMPT_INJECTION_MODES)[number]

/**
 * exec = 一次性 headless 运行（注入 prompt → 收集输出 → 结构化返回）。
 * acp 是给后续 orca / claude-code-acp 这类 JSON-RPC stdio agent 预留的协议位：
 * schema 放行、resolveConfig 明确报「未实现」，避免将来加协议时改配置结构。
 */
export const PROTOCOLS = ['exec'] as const
export type Protocol = (typeof PROTOCOLS)[number]
export const RESERVED_PROTOCOLS = ['acp'] as const

export type OutputFormat = 'text' | 'json'

export interface AgentConfigInput {
  command?: unknown
  args?: unknown
  detect?: unknown
  promptInjectionMode?: unknown
  promptFlag?: unknown
  argvSeparator?: unknown
  cwd?: unknown
  env?: unknown
  timeoutMs?: unknown
  outputFormat?: unknown
  maxConcurrent?: unknown
  protocol?: unknown
  description?: unknown
}

export interface CliAgentsConfigInput {
  agents?: Record<string, AgentConfigInput>
  detectOnStart?: unknown
  log?: { level?: unknown; dir?: unknown }
}

export interface ResolvedAgent {
  id: string
  /** 原始命令名（PATH 解析在 runtime 做，保持 run/detect 行为一致） */
  command: string
  args: string[]
  /** 探测命令；缺省 = `${command} --version` */
  detect: string
  promptInjectionMode: PromptInjectionMode
  promptFlag?: string
  argvSeparator?: string
  /** 已按插件启动目录解析为绝对路径 */
  cwd?: string
  env: Record<string, string>
  timeoutMs: number
  outputFormat: OutputFormat
  maxConcurrent: number
  protocol: Protocol
  description: string
}

export interface ResolvedConfig {
  agents: Map<string, ResolvedAgent>
  detectOnStart: boolean
  logLevel: LogLevel
  logDir?: string
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`clh-cli-agents 配置有 ${problems.length} 个问题:\n- ${problems.join('\n- ')}`)
  }
}

export class CliAgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(`[${code}] ${message}`)
  }
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i
const KNOWN_AGENT_FIELDS = new Set([
  'command', 'args', 'detect', 'promptInjectionMode', 'promptFlag', 'argvSeparator',
  'cwd', 'env', 'timeoutMs', 'outputFormat', 'maxConcurrent', 'protocol', 'description',
])
// 与 Claude Code hooks 的默认值对齐（参考实现的上游惯例）：单次外部 agent 运行默认给 10 分钟
const DEFAULT_TIMEOUT_MS = 600_000

function interpolateEnv(value: string, where: string, problems: string[]): string {
  return value.replace(ENV_RE, (raw, name: string) => {
    const resolved = process.env[name]
    if (resolved === undefined) {
      problems.push(`${where}: 环境变量 ${name} 未设置（${raw}）`)
      return ''
    }
    return resolved
  })
}

function asString(value: unknown, where: string, problems: string[]): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${where}: 应为非空字符串`)
    return undefined
  }
  return value
}

function asStringArray(value: unknown, where: string, problems: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    problems.push(`${where}: 应为字符串数组`)
    return undefined
  }
  return value as string[]
}

function asNumber(value: unknown, where: string, problems: string[], { min }: { min: number }): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    problems.push(`${where}: 应为 >= ${min} 的数字`)
    return undefined
  }
  return value
}

/** 解析并校验整份配置；有问题全部收集后一次抛出。 */
export function resolveConfig(raw: CliAgentsConfigInput, baseDir: string): ResolvedConfig {
  const problems: string[] = []
  const agents = new Map<string, ResolvedAgent>()

  const rawAgents = raw?.agents
  if (rawAgents !== undefined && (typeof rawAgents !== 'object' || rawAgents === null || Array.isArray(rawAgents))) {
    problems.push('agents: 应为对象（agent id → 配置）')
  } else if (rawAgents) {
    for (const [id, input] of Object.entries(rawAgents as Record<string, AgentConfigInput>)) {
      if (!AGENT_ID_RE.test(id)) {
        problems.push(`agents.${id}: id 只允许字母/数字/-/_ 且以字母或数字开头`)
        continue
      }
      const where = `agents.${id}`
      if (typeof input !== 'object' || input === null) {
        problems.push(`${where}: 应为对象`)
        continue
      }
      for (const key of Object.keys(input)) {
        if (!KNOWN_AGENT_FIELDS.has(key)) problems.push(`${where}.${key}: 未知字段`)
      }

      const command = asString(input.command, `${where}.command`, problems)
      if (!command) continue

      const mode = (asString(input.promptInjectionMode, `${where}.promptInjectionMode`, problems)
        ?? 'argv') as PromptInjectionMode
      if (!PROMPT_INJECTION_MODES.includes(mode)) {
        problems.push(`${where}.promptInjectionMode: 只支持 ${PROMPT_INJECTION_MODES.join(' / ')}`)
      }

      const promptFlag = asString(input.promptFlag, `${where}.promptFlag`, problems)
      if (mode === 'flag-prompt' && !promptFlag) {
        problems.push(`${where}.promptFlag: promptInjectionMode=flag-prompt 必须提供 prompt 旗标（如 --prefill）`)
      }
      if (mode !== 'flag-prompt' && promptFlag) {
        problems.push(`${where}.promptFlag: 只有 flag-prompt 模式使用 promptFlag（当前 ${mode}）`)
      }

      const protocol = (asString(input.protocol, `${where}.protocol`, problems) ?? 'exec') as Protocol
      if (protocol !== 'exec') {
        problems.push(
          `${where}.protocol: ${protocol} 协议已预留但本版本未实现，请用 exec（headless 一次性运行）`,
        )
      }

      const outputFormat = (asString(input.outputFormat, `${where}.outputFormat`, problems) ?? 'text') as OutputFormat
      if (outputFormat !== 'text' && outputFormat !== 'json') {
        problems.push(`${where}.outputFormat: 只支持 text / json`)
      }

      const env: Record<string, string> = {}
      if (input.env !== undefined && input.env !== null) {
        if (typeof input.env !== 'object' || Array.isArray(input.env)) {
          problems.push(`${where}.env: 应为字符串字典`)
        } else {
          for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) {
            if (typeof v !== 'string') {
              problems.push(`${where}.env.${k}: 应为字符串`)
              continue
            }
            env[k] = interpolateEnv(v, `${where}.env.${k}`, problems)
          }
        }
      }

      const cwdRaw = asString(input.cwd, `${where}.cwd`, problems)
      const cwd = cwdRaw === undefined ? undefined : interpolateEnv(cwdRaw, `${where}.cwd`, problems)
      const argvSeparator = asString(input.argvSeparator, `${where}.argvSeparator`, problems)
      const detect = asString(input.detect, `${where}.detect`, problems) ?? `${command} --version`
      const description = asString(input.description, `${where}.description`, problems) ?? ''

      agents.set(id, {
        id,
        command,
        args: asStringArray(input.args, `${where}.args`, problems) ?? [],
        detect,
        promptInjectionMode: mode,
        promptFlag,
        argvSeparator: argvSeparator ?? undefined,
        cwd: cwdRaw === undefined ? undefined : path.resolve(baseDir, cwdRaw),
        env,
        timeoutMs: asNumber(input.timeoutMs, `${where}.timeoutMs`, problems, { min: 1 }) ?? DEFAULT_TIMEOUT_MS,
        outputFormat,
        maxConcurrent: asNumber(input.maxConcurrent, `${where}.maxConcurrent`, problems, { min: 1 }) ?? 1,
        protocol: 'exec',
        description: description ?? '',
      })
    }
  }

  const logLevelRaw = raw?.log?.level
  if (logLevelRaw !== undefined && !['debug', 'info', 'warn', 'error'].includes(logLevelRaw as string)) {
    problems.push('log.level: 只支持 debug / info / warn / error')
  }
  const logDirRaw = raw?.log?.dir
  if (logDirRaw !== undefined && typeof logDirRaw !== 'string') {
    problems.push('log.dir: 应为字符串路径')
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return {
    agents,
    detectOnStart: raw?.detectOnStart === undefined ? true : Boolean(raw.detectOnStart),
    logLevel: (logLevelRaw as LogLevel | undefined) ?? 'info',
    logDir: (logDirRaw as string | undefined) ?? undefined,
  }
}

/** Schemastery schema：settings 面与 loader 校验用；运行时语义以 resolveConfig 为准。 */
export function buildConfigSchema(S: typeof Schema) {
  return S.object({
    agents: S.dict(S.object({
      command: S.string().required().description('启动命令（PATH 上可解析的可执行文件；Windows 不支持 .cmd/.bat 包装）'),
      args: S.array(S.string()).description('固定参数，如 -p --output-format json'),
      detect: S.string().description('探测命令，缺省为 `<command> --version`'),
      promptInjectionMode: S.union([...PROMPT_INJECTION_MODES]).description('prompt 注入方式（orca 语义）'),
      promptFlag: S.string().description('flag-prompt 模式的旗标，如 --prefill'),
      argvSeparator: S.string().description('argv 模式的分隔符（如 --），防止 prompt 被当成旗标'),
      cwd: S.string().description('工作目录，缺省用插件进程 cwd'),
      env: S.dict(S.string()).description('附加环境变量，支持 ${ENV} 插值'),
      timeoutMs: S.number().description('单次运行超时，默认 600000'),
      outputFormat: S.union(['text', 'json']).description('json 时尝试解析 stdout 里的 JSON 值'),
      maxConcurrent: S.number().description('同 agent 并发上限，默认 1（超出排队）'),
      protocol: S.union([...PROTOCOLS, ...RESERVED_PROTOCOLS]).description('exec（已实现）/ acp（预留）'),
      description: S.string().description('人类可读说明'),
    })).description('外部 CLI agent 目录（orca 式声明）'),
    detectOnStart: S.boolean().description('服务启动时探测全部 agent，默认 true'),
    log: S.object({
      level: S.union(['debug', 'info', 'warn', 'error']).description('日志级别，默认 info'),
      dir: S.string().description('JSONL 日志目录；不给则只输出 console'),
    }),
  })
}
