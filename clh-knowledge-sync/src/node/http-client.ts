/**
 * hub 客户端：按 profile（协议/主机/端口/basePath/超时/TLS）发起 REST 请求。
 * 所有失败都归一为 SyncError（connect-failed / timeout / http-error / tls-error），
 * 携带可定位的上下文（profile、地址、状态码、服务端错误码），调用方据此记日志。
 */
import { readFileSync } from 'node:fs'
import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import path from 'node:path'
import type { ResolvedProfile } from '../config.js'
import type { Logger } from '../logger.js'
import { SyncError } from '../util.js'

export class HubClient {
  private agent?: HttpAgent | HttpsAgent

  constructor(
    private readonly profile: ResolvedProfile,
    private readonly logger: Logger,
  ) {}

  baseUrl(): string {
    const { protocol, host, port, basePath } = this.profile
    return `${protocol}://${host}:${port}${basePath}`
  }

  describe(): string {
    const p = this.profile
    const tlsMark = p.protocol === 'https' ? (p.rejectUnauthorized ? ' (TLS 校验开启)' : ' (TLS 校验关闭)') : ''
    return `${p.protocol}://${p.host}:${p.port}${p.basePath}${tlsMark} [profile=${p.name}]`
  }

  /** 连通性探测：GET /healthz（无需 token）。 */
  async health(): Promise<{ ok: boolean; service?: string; stats?: unknown }> {
    return this.request('GET', '/healthz', { auth: false })
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    pathName: string,
    opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl() + pathName)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)

    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) }
    if (opts.auth !== false) headers.authorization = `Bearer ${this.profile.token}`
    let payload: Buffer | undefined
    if (opts.body !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.body), 'utf8')
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }

    const { status, text } = await this.rawRequest(method, url, headers, payload)
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      throw new SyncError('bad-response', `${method} ${url.pathname} 返回的不是 JSON（HTTP ${status}）`, { bodyPreview: text.slice(0, 200) })
    }
    if (status >= 400) {
      const err = (parsed as { error?: { code?: string; message?: string } })?.error
      throw new SyncError('http-error', `hub 返回 ${status}${err?.code ? ` (${err.code})` : ''}: ${err?.message ?? '无错误详情'}`, {
        status,
        code: err?.code,
        path: url.pathname,
      })
    }
    return parsed as T
  }

  private rawRequest(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payload?: Buffer,
  ): Promise<{ status: number; text: string }> {
    const isHttps = url.protocol === 'https:'
    const send = isHttps ? httpsRequest : httpRequest
    const options: RequestOptions = {
      method,
      host: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      agent: this.getAgent(isHttps),
      signal: AbortSignal.timeout(this.profile.timeoutMs),
    }
    return new Promise((resolve, reject) => {
      const req = send(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', (err) => reject(new SyncError('bad-response', `读取响应失败: ${err.message}`)))
      })
      req.on('error', (err: NodeJS.ErrnoException) => reject(this.mapNetworkError(err, method, url)))
      req.on('timeout', () => {
        req.destroy(new SyncError('timeout', `请求超时（>${this.profile.timeoutMs}ms）: ${method} ${url.toString()}`))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  private mapNetworkError(err: NodeJS.ErrnoException, method: string, url: URL): SyncError {
    const code = err.code ?? 'unknown'
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new SyncError('connect-failed', `无法连接 hub ${this.describe()}（${code}）；请检查配置中的地址/端口与 hub 是否在线`, {
        code,
        method,
        url: url.toString(),
      })
    }
    if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      return new SyncError(
        'tls-error',
        `TLS 校验失败（${code}）：外网部署请把 profiles.<p>.tls.caFile 指向 hub 的 CA 证书，或明确设置 rejectUnauthorized=false（不推荐）`,
        { code },
      )
    }
    if (err instanceof SyncError) return err
    return new SyncError('network', `网络错误（${code}）: ${err.message}`, { method, url: url.toString() })
  }

  private getAgent(isHttps: boolean): HttpAgent | HttpsAgent {
    if (this.agent) return this.agent
    if (isHttps) {
      const opts: { keepAlive: boolean; rejectUnauthorized: boolean; ca?: string } = {
        keepAlive: true,
        rejectUnauthorized: this.profile.rejectUnauthorized,
      }
      if (this.profile.caFile) {
        // CA 文件缺失在这里显式报错，不会静默退回系统 CA
        const caPath = path.isAbsolute(this.profile.caFile)
          ? this.profile.caFile
          : path.resolve(process.cwd(), this.profile.caFile)
        try {
          opts.ca = readFileSync(caPath, 'utf8')
        } catch (err) {
          throw new SyncError('tls-error', `tls.caFile 无法读取: ${caPath}: ${(err as Error).message}`)
        }
      }
      this.agent = new HttpsAgent(opts)
      return this.agent
    }
    this.agent = new HttpAgent({ keepAlive: true })
    return this.agent
  }
}
