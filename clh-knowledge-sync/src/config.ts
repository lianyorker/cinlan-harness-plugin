/**
 * 配置层。
 * - 插件侧：Schemastery schema（cordis loader 在 apply 前校验，配错即加载失败并给准确报错）。
 * - hub 侧：独立进程不走 cordis，用 loadHubConfig 读 JSON + ${ENV} 插值 + 显式校验。
 * 全部连接参数（协议/地址/端口/TLS/超时/token）来自配置文件或环境变量，零硬编码地址。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { SyncError } from './util.js'

// ---------------- 插件配置（cordis / Schemastery） ----------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any

interface HubProfileConfig {
  protocol: string
  host: string
  port?: number
  basePath?: string
  timeoutMs?: number
  token?: string
  tls?: { rejectUnauthorized?: boolean; caFile?: string }
}

export interface NodeSyncConfig {
  node: { id: string; token: string }
  hub: { activeProfile: string; profiles: Record<string, HubProfileConfig | undefined> }
  sync: {
    auto: boolean
    intervalSec: number
    syncOnStart: boolean
    memoryDir: string
    skillRoots: string[]
    stateDirName: string
  }
  oneshot: { enabled: boolean; commands: string[]; resultFile: string }
  log: { level: string; dir: string }
}

/** 由 schemastery 校验后的插件配置（结构同 NodeSyncConfig，字段可能带默认值）。 */
export function buildConfigSchema(Schema: AnySchema): AnySchema {
  const hubProfile = Schema.object({
    protocol: Schema.union(['http', 'https']).required(),
    host: Schema.string().required(),
    port: Schema.number(),
    basePath: Schema.string().default(''),
    timeoutMs: Schema.number().default(8000),
    token: Schema.string().role('secret'),
    tls: Schema.object({
      rejectUnauthorized: Schema.boolean().default(true),
      caFile: Schema.string(),
    }),
  })

  // volatile 分组：settings UI 可直接编辑、写回后免 remount（clhKnowledgeSyncService 接 internal/update 重建运行时）。
  // role('secret') 字段在 settings describe 输出里脱敏，配置页按只写处理。
  return Schema.object({
    node: Schema.object({
      id: Schema.string().required(),
      token: Schema.string().required().role('secret'),
    }).required().volatile(),
    hub: Schema.object({
      activeProfile: Schema.string().default('intranet'),
      // 任意名字的 profile 字典（intranet/extranet 只是约定俗成的示例名）
      profiles: Schema.dict(hubProfile),
    }).required().volatile(),
    sync: Schema.object({
      auto: Schema.boolean().default(true),
      intervalSec: Schema.number().default(300),
      syncOnStart: Schema.boolean().default(true),
      memoryDir: Schema.string().required(),
      skillRoots: Schema.array(Schema.string()).default([]),
      stateDirName: Schema.string().default('.clh-knowledge-sync'),
    }).required().volatile(),
    oneshot: Schema.object({
      enabled: Schema.boolean().default(false),
      commands: Schema.array(Schema.string()).default([]),
      resultFile: Schema.string().default(''),
    }).volatile(),
    log: Schema.object({
      level: Schema.union(['debug', 'info', 'warn', 'error']).default('info'),
      dir: Schema.string().default(''),
    }).volatile(),
  })
}

export interface ResolvedProfile {
  name: string
  protocol: 'http' | 'https'
  host: string
  port: number
  basePath: string
  timeoutMs: number
  token: string
  rejectUnauthorized: boolean
  caFile?: string
}

export interface ResolvedNodeConfig {
  nodeId: string
  token: string
  profile: ResolvedProfile
  auto: boolean
  intervalSec: number
  syncOnStart: boolean
  memoryDir: string
  skillRoots: string[]
  stateDir: string
  logLevel: string
  logDir: string
  oneshot: { enabled: boolean; commands: string[]; resultFile: string }
}

function defaultPort(protocol: string): number {
  return protocol === 'https' ? 443 : 80
}

/**
 * 归并插件原始配置为运行时配置。
 * schema 已保证必填项存在；这里负责解析激活 profile、补默认端口、路径绝对化，
 * 并在引用不存在的 profile 或 token 为空时给出能直接定位问题的错误。
 */
export function resolveNodeConfig(raw: NodeSyncConfig, cwd = process.cwd()): ResolvedNodeConfig {
  const problems: string[] = []
  if (!raw.node?.id) problems.push('node.id 不能为空')
  const token = raw.node?.token ?? ''
  if (!token) problems.push('node.token 不能为空（可用 ${ENV} 或 !!js process.env.X 从环境变量注入）')

  const hubCfg = raw.hub
  const activeName = hubCfg?.activeProfile || 'intranet'
  const profiles = hubCfg?.profiles ?? {}
  const chosen = profiles[activeName]
  if (!chosen) {
    problems.push(
      `hub.activeProfile="${activeName}" 在 hub.profiles 中不存在（可用: ${Object.keys(profiles).join(', ') || '无'}）`,
    )
  } else {
    if (!chosen.host) problems.push(`hub.profiles.${activeName}.host 不能为空`)
    if (chosen.protocol !== 'http' && chosen.protocol !== 'https') {
      problems.push(`hub.profiles.${activeName}.protocol 必须是 http 或 https`)
    }
    const profileToken = chosen.token ?? token
    if (!profileToken) problems.push(`hub.profiles.${activeName}.token 与 node.token 均为空`)
    if (chosen.protocol === 'https' && chosen.tls?.caFile) {
      // CA 文件存在性在连接前校验（http-client 里），这里只查路径非空
    }
  }

  if (!raw.sync?.memoryDir) problems.push('sync.memoryDir 不能为空')
  if (problems.length) {
    throw new SyncError('invalid-config', `clh-knowledge-sync 配置有 ${problems.length} 处问题:\n  - ${problems.join('\n  - ')}`)
  }

  const profile: ResolvedProfile = {
    name: activeName,
    protocol: chosen!.protocol as 'http' | 'https',
    host: chosen!.host,
    port: chosen!.port ?? defaultPort(chosen!.protocol),
    basePath: (chosen!.basePath ?? '').replace(/\/+$/, ''),
    timeoutMs: chosen!.timeoutMs ?? 8000,
    token: chosen!.token ?? token,
    rejectUnauthorized: chosen!.tls?.rejectUnauthorized ?? true,
    caFile: chosen!.tls?.caFile || undefined,
  }

  const memoryDir = path.resolve(cwd, raw.sync.memoryDir)
  const skillRoots = (raw.sync.skillRoots ?? []).map((r) => path.resolve(cwd, r))
  const stateDir = path.join(memoryDir, raw.sync.stateDirName || '.clh-knowledge-sync')

  return {
    nodeId: raw.node.id,
    token,
    profile,
    auto: raw.sync.auto ?? true,
    intervalSec: raw.sync.intervalSec ?? 300,
    syncOnStart: raw.sync.syncOnStart ?? true,
    memoryDir,
    skillRoots,
    stateDir,
    logLevel: raw.log?.level ?? 'info',
    logDir: raw.log?.dir ? path.resolve(cwd, raw.log.dir) : path.join(stateDir, 'logs'),
    oneshot: {
      enabled: raw.oneshot?.enabled ?? false,
      commands: raw.oneshot?.commands ?? [],
      resultFile: raw.oneshot?.resultFile ? path.resolve(cwd, raw.oneshot.resultFile) : '',
    },
  }
}

// ---------------- hub 配置（JSON 文件 + ${ENV} 插值） ----------------

export interface HubListenConfig {
  protocol: 'http' | 'https'
  host: string
  port: number
  tls?: { certFile?: string; keyFile?: string }
}

export interface HubConfig {
  listen: HubListenConfig
  auth: { adminToken: string; nodeTokens: Record<string, string> }
  dataDir: string
  limits: { maxBodyBytes: number; maxFileBytes: number; maxItemsPerPush: number }
  log: { level: string; dir: string }
}

/** 展开 "${ENV_NAME}" 占位符；缺失的环境变量直接报错，不静默替换为空。 */
export function interpolateEnv(text: string, label: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
    const value = process.env[name]
    if (value === undefined || value === '') {
      throw new SyncError('missing-env', `${label}: 环境变量 ${name} 未设置（配置里的 \${${name}} 无法解析）`)
    }
    return value
  })
}

/** 读取并校验 hub 配置；任何缺失/非法都逐条列出，不静默兜底。 */
export async function loadHubConfig(file: string, overrides: { port?: number } = {}): Promise<HubConfig> {
  let rawText: string
  try {
    rawText = await fsp.readFile(file, 'utf8')
  } catch (err) {
    throw new SyncError('io-error', `无法读取 hub 配置文件 ${file}: ${(err as Error).message}`)
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(interpolateEnv(rawText, path.basename(file)))
  } catch (err) {
    if (err instanceof SyncError) throw err
    throw new SyncError('invalid-config', `hub 配置不是合法 JSON: ${file}: ${(err as Error).message}`)
  }
  return validateHubConfig(raw, file, overrides)
}

export function validateHubConfig(
  raw: Record<string, unknown>,
  sourceFile: string,
  overrides: { port?: number } = {},
): HubConfig {
  const problems: string[] = []
  const listenRaw = (raw.listen ?? {}) as Record<string, unknown>
  const protocol = listenRaw.protocol
  if (protocol !== 'http' && protocol !== 'https') {
    problems.push(`listen.protocol 必须是 http 或 https，收到 "${String(protocol)}"`)
  }
  const host = listenRaw.host
  if (typeof host !== 'string' || !host) problems.push('listen.host 不能为空')
  const port = overrides.port ?? (listenRaw.port as number | undefined)
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    problems.push(`listen.port 必须是 1-65535 的整数，收到 "${String(port)}"`)
  }
  const tls = (listenRaw.tls ?? {}) as { certFile?: string; keyFile?: string }
  if (protocol === 'https') {
    if (!tls.certFile) problems.push('listen.protocol=https 时必须提供 listen.tls.certFile')
    if (!tls.keyFile) problems.push('listen.protocol=https 时必须提供 listen.tls.keyFile')
  }

  const authRaw = (raw.auth ?? {}) as Record<string, unknown>
  const adminToken = authRaw.adminToken
  if (typeof adminToken !== 'string' || !adminToken) problems.push('auth.adminToken 不能为空')
  const nodeTokens = (authRaw.nodeTokens ?? {}) as Record<string, string>
  const nodeEntries = Object.entries(nodeTokens).filter(([k, v]) => k && typeof v === 'string' && v)
  if (nodeEntries.length === 0) problems.push('auth.nodeTokens 至少要配置一个节点 token')

  const dataDir = typeof raw.dataDir === 'string' && raw.dataDir
    ? path.resolve(path.dirname(sourceFile), raw.dataDir)
    : ''
  if (!dataDir) problems.push('dataDir 不能为空')

  if (problems.length) {
    throw new SyncError('invalid-config', `hub 配置 ${sourceFile} 有 ${problems.length} 处问题:\n  - ${problems.join('\n  - ')}`)
  }

  const limitsRaw = (raw.limits ?? {}) as Record<string, unknown>
  return {
    listen: {
      protocol: protocol as 'http' | 'https',
      host: host as string,
      port: port as number,
      tls: protocol === 'https' ? { certFile: tls.certFile, keyFile: tls.keyFile } : undefined,
    },
    auth: { adminToken: adminToken as string, nodeTokens: Object.fromEntries(nodeEntries) },
    dataDir: dataDir!,
    limits: {
      maxBodyBytes: typeof limitsRaw.maxBodyBytes === 'number' ? limitsRaw.maxBodyBytes : 20 * 1024 * 1024,
      maxFileBytes: typeof limitsRaw.maxFileBytes === 'number' ? limitsRaw.maxFileBytes : 5 * 1024 * 1024,
      maxItemsPerPush: typeof limitsRaw.maxItemsPerPush === 'number' ? limitsRaw.maxItemsPerPush : 100,
    },
    log: {
      level: (raw.log as { level?: string } | undefined)?.level ?? 'info',
      dir: (raw.log as { dir?: string } | undefined)?.dir ?? '',
    },
  }
}
