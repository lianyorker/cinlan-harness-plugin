/**
 * @cinlan/redaction host plugin: outbound LLM redaction on the
 * `llm/stream` waterfall, magpie-style stable HMAC placeholders, inbound
 * restoration, and an in-memory record buffer exposed via /api Remote.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { maskText, StreamRestorer, type EngineOptions } from './engine.ts'
import { RecordBuffer } from './records.ts'
import { PlaceholderStore } from './store.ts'
import type { RedactionRecordValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    redaction: RedactionService
  }
}

export const name = 'cinlan-redaction'
export const inject = ['llm']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any

export const Config: AnySchema = Schema.object({
  secrets: Schema.boolean().default(false).description('Mask secret-shaped values: API keys, private keys, tokens, passwords.'),
  personal: Schema.boolean().default(false).description('Mask personal data: email, phone, ID card, bank card.'),
  kinds: Schema.object({
    EMAIL: Schema.boolean().default(true),
    PHONE: Schema.boolean().default(true),
    ID_CARD: Schema.boolean().default(true),
    BANK_CARD: Schema.boolean().default(true),
    // extended categories (magpie more.go defaults: the first six on,
    // home/userhost/ip/bucket off until the user turns them on)
    ssn: Schema.boolean().default(true),
    passport: Schema.boolean().default(true),
    iban: Schema.boolean().default(true),
    birthday: Schema.boolean().default(true),
    mac: Schema.boolean().default(true),
    serial: Schema.boolean().default(true),
    home: Schema.boolean().default(false),
    userhost: Schema.boolean().default(false),
    ip: Schema.boolean().default(false),
    bucket: Schema.boolean().default(false),
  }).default({ EMAIL: true, PHONE: true, ID_CARD: true, BANK_CARD: true }),
  words: Schema.array(String).default([]).description('Your words: project codenames, internal hostnames, client names.'),
  wordsAnyCase: Schema.boolean().default(false).description('Match words in any case: Nightjar masks NIGHTJAR too.'),
  wordsWhole: Schema.boolean().default(false).description('Match words only as whole words: ABC masks ABC IS but not XABCD.'),
  rules: Schema.array(Schema.object({
    kind: Schema.string().required(),
    prefix: Schema.string(),
    regex: Schema.string(),
  })).default([]).description('Custom rules: prefix or regex (either one).'),
  allow: Schema.array(String).default([]).description('Whole values allowed through as written.'),
  actions: Schema.dict(Schema.union(['warn', 'block'] as const)).default({})
    .description('Per-kind action override: warn = send as written and record, block = mask and hold the request back.'),
  skipProviders: Schema.array(String).default([]).description('Provider routes never redacted (GenerateOptions.provider ids).'),
  records: Schema.boolean().default(true).description('Keep redaction records for the detail tab.'),
})

// settings 只投影 volatile 字段；逐字段标记，保留对象形状。
for (const field of Object.values(Config.dict) as AnySchema[]) field.volatile()

export interface RedactionConfig {
  secrets: boolean
  personal: boolean
  kinds: Record<string, boolean>
  words: string[]
  wordsAnyCase: boolean
  wordsWhole: boolean
  rules: Array<{ kind: string; prefix?: string; regex?: string }>
  allow: string[]
  actions: Record<string, 'warn' | 'block'>
  skipProviders: string[]
  records: boolean
}

interface AnyChunk {
  type: string
  index?: number
  text?: string
  id?: string
  name?: string
  argumentsDelta?: string
  block?: { type?: string; text?: string; arguments?: string }
  [k: string]: unknown
}

interface AnyMessage {
  role?: string
  content?: unknown
  [k: string]: unknown
}

export class RedactionService extends Service {
  private readonly store: PlaceholderStore
  private readonly records = new RecordBuffer(1000)
  private readonly logger: ReturnType<Context['logger']>

  /**
   * Typert Gateway binding: same shape as typert-protocol's
   * bindTypertRemote product, built by hand so the plugin keeps depending
   * on cordis only. The /api gateway's SRC discovery claims redaction/*
   * endpoints through it (owner Peer only without a resources marker).
   */
  readonly typertRemote: { readonly service: object; readonly serviceKey: string; readonly namespace: string } = Object.freeze({
    service: this,
    serviceKey: 'redaction',
    namespace: 'redaction',
  })

  private config: RedactionConfig

  constructor(ctx: Context, config: RedactionConfig) {
    super(ctx, 'redaction')
    this.logger = ctx.logger('redaction')
    this.config = this.resolveConfig(config)
    ctx.on('internal/update', (nextConfig: RedactionConfig, next: () => void) => {
      this.config = this.resolveConfig(nextConfig)
      return next()
    })
    // stable anchor: explicit override → DSH_HOME → ~/.dsh. A process.cwd()
    // fallback made the HMAC key wander with the launch directory and broke
    // cross-restart placeholder stability.
    const stateRoot = process.env.DSH_REDACTION_STATE_DIR
      ?? process.env.DSH_HOME
      ?? join(homedir(), '.dsh')
    const stateDir = join(stateRoot, '.dsh-redaction')
    try {
      mkdirSync(stateDir, { recursive: true })
    } catch { /* in-memory key only */ }
    this.store = new PlaceholderStore(join(stateDir, 'placeholder-key'))
  }

  /** 解开 Cordis 的实时配置引用；每次更新使用同一个已校验快照。 */
  private resolveConfig(config: RedactionConfig): RedactionConfig {
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [
      key, value && typeof value.get === 'function' ? value.get() : value,
    ])) as unknown as RedactionConfig
  }

  protected [Service.init](): void {
    const self = this
    // 两套宿主的 llm/stream next() 都闭包捕获原请求且请求已冻结。
    // 包装共同的 adapterStream 边界，保留 prepared dispatch 与 middleware。
    // 这是宿主内部接口；缺失时拒绝加载，避免静默漏脱敏。
    const llm = this.ctx.get('llm') as unknown as {
      adapterStream(options: Record<string, unknown>, prepared?: unknown): AsyncIterable<AnyChunk>
    }
    if (typeof llm?.adapterStream !== 'function') throw new Error('redaction: incompatible LLM adapterStream boundary')
    const original = llm.adapterStream
    const descriptor = Object.getOwnPropertyDescriptor(llm, 'adapterStream')
    const wrapped = (options: Record<string, unknown>, prepared?: unknown) =>
      self.intercept(options, masked => original.call(llm, masked, prepared))
    Object.defineProperty(llm, 'adapterStream', { configurable: true, writable: true, value: wrapped })
    this.ctx.effect(() => () => {
      if (descriptor) Object.defineProperty(llm, 'adapterStream', descriptor)
      else Reflect.deleteProperty(llm, 'adapterStream')
    })
  }

  private engineOptions(): EngineOptions {
    const c = this.config
    return {
      secrets: c.secrets,
      personal: c.personal,
      kinds: c.kinds ?? {},
      words: c.words ?? [],
      wordsAnyCase: c.wordsAnyCase ?? false,
      wordsWhole: c.wordsWhole ?? false,
      rules: c.rules ?? [],
      allow: c.allow ?? [],
      actions: c.actions ?? {},
    }
  }

  private enabled(): boolean {
    const c = this.config
    return c.secrets || c.personal || (c.words?.length ?? 0) > 0 || (c.rules?.length ?? 0) > 0
  }

  /** Mask one text-bearing field of a cloned request; returns true when something was replaced. */
  private maskValue(value: string, path: string, hits: RedactionRecordValue[], counter: { replaced: number }): string {
    const before = value.length > 200 ? value.slice(0, 200) + '…' : value
    const res = maskText(value, this.engineOptions(), this.store, (hit, _v, p) => {
      const existing = hits.find(h => h.placeholder === hit.placeholder)
      if (existing) existing.n++
      else hits.push({ placeholder: hit.placeholder, kind: hit.kind, by: hit.by, head: hit.head, len: hit.len, n: 1, action: hit.action, path: p, restored: 0, before })
    }, path)
    counter.replaced += res.replaced
    const after = res.text.length > 200 ? res.text.slice(0, 200) + '…' : res.text
    for (const h of hits) {
      if (h.before === before && !h.after) h.after = after
    }
    return res.text
  }

  private maskRequest(options: Record<string, unknown>): { replaced: number; hits: RedactionRecordValue[]; blocked: boolean } {
    const hits: RedactionRecordValue[] = []
    const counter = { replaced: 0 }
    const maskTextAt = (v: unknown, path: string): unknown => {
      if (typeof v === 'string') return this.maskValue(v, path, hits, counter)
      if (Array.isArray(v)) return v.map((x, i) => maskTextAt(x, `${path}[${i}]`))
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v)) out[k] = maskTextAt(x, `${path}.${k}`)
        return out
      }
      return v
    }
    if (typeof options.system === 'string') options.system = this.maskValue(options.system, 'system', hits, counter)
    if (Array.isArray(options.messages)) {
      options.messages = (options.messages as AnyMessage[]).map((m, i) => {
        const masked = maskTextAt(m.content, `messages[${i}].content`)
        return masked === m.content ? m : { ...m, content: masked }
      })
    }
    if (Array.isArray(options.tools)) {
      options.tools = (options.tools as Array<Record<string, unknown>>).map((t, i) => {
        if (typeof t.description === 'string') {
          const d = this.maskValue(t.description, `tools[${i}].description`, hits, counter)
          return d === t.description ? t : { ...t, description: d }
        }
        return t
      })
    }
    const blocked = hits.some(h => h.action === 'block')
    return { replaced: counter.replaced, hits, blocked }
  }

  private intercept(options: Record<string, unknown>, next: (options: Record<string, unknown>) => AsyncIterable<AnyChunk>): AsyncIterable<AnyChunk> {
    const started = Date.now()
    const opts = options as unknown as Record<string, unknown>
    if (!this.enabled() || opts === null || typeof opts !== 'object') return next(opts)
    // skipProviders: these provider routes get requests exactly as written
    const provider = String(opts.provider ?? '')
    if (provider && (this.config.skipProviders ?? []).includes(provider)) return next(opts)
    const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : ''
    let recordId = -1
    let hits: RedactionRecordValue[] = []
    return (async function* (self: RedactionService): AsyncIterable<AnyChunk> {
      // fail-closed: any engine failure rejects the request instead of
      // passing plaintext through (REDACTION_FAILED, never a silent send)
      let clone: Record<string, unknown>
      let replaced = 0
      let blocked = false
      try {
        // AbortSignal 等运行时句柄保持原引用，只复制 maskRequest 改写的内容。
        clone = { ...opts }
        const masked = self.maskRequest(clone)
        replaced = masked.replaced
        blocked = masked.blocked
        hits = masked.hits
      } catch (err) {
        self.logger.error('redaction-failed', 'masking engine failed; request rejected (fail-closed)', { error: (err as Error).message })
        throw Object.assign(new Error('redaction: engine failed; request rejected (fail-closed)'), { code: 'REDACTION_FAILED' })
      }
      const bytes = JSON.stringify(clone).length
      if (self.config.records) {
        const rec = self.records.add({
          sessionId,
          turn: self.records.nextTurn(),
          provider,
          model: String(clone.model ?? ''),
          bytes,
          values: hits,
          replaced,
          tookMs: Date.now() - started,
          blocked,
          restored: 0,
        })
        recordId = rec.id
      }
      if (blocked) {
        throw Object.assign(new Error('redaction: request blocked by a block action'), { code: 'REDACTION_BLOCKED' })
      }
      const stream = next(clone)
      const textRestorers = new Map<number, StreamRestorer>()
      const argRestorers = new Map<string, { r: StreamRestorer; id?: string | undefined; index?: number | undefined }>()
      // per-request restore tally: total + per-placeholder counts for the record
      let restoredTotal = 0
      const valueRestores = new Map<string, number>()
      const fold = (r: StreamRestorer): void => {
        restoredTotal += r.restored
        for (const [ph, n] of r.counts) valueRestores.set(ph, (valueRestores.get(ph) ?? 0) + n)
      }
      try {
        for await (const chunk of stream) {
          if (chunk === null || typeof chunk !== 'object') {
            yield chunk
            continue
          }
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            const idx = chunk.index ?? 0
            let r = textRestorers.get(idx)
            if (r === undefined) {
              r = new StreamRestorer(self.store)
              textRestorers.set(idx, r)
            }
            const out = r.push(String(chunk.text ?? ''))
            yield { ...chunk, text: out }
          } else if (chunk.type === 'tool-call-delta') {
            const key = String(chunk.id ?? chunk.index ?? 0)
            let e = argRestorers.get(key)
            if (e === undefined) {
              e = { r: new StreamRestorer(self.store), id: chunk.id, index: chunk.index }
              argRestorers.set(key, e)
            }
            const out = e.r.push(String(chunk.argumentsDelta ?? ''))
            yield { ...chunk, argumentsDelta: out }
          } else if (chunk.type === 'block-end' && chunk.block && (chunk.block.type === 'text' || chunk.block.type === 'tool-call') && typeof chunk.block.text === 'string') {
            const r = new StreamRestorer(self.store)
            const text = r.push(chunk.block.text) + r.flush()
            fold(r)
            yield { ...chunk, block: { ...chunk.block, text } }
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call' && typeof chunk.block.arguments === 'string') {
            const r = new StreamRestorer(self.store)
            const args = r.push(chunk.block.arguments) + r.flush()
            fold(r)
            yield { ...chunk, block: { ...chunk.block, arguments: args } }
          } else {
            yield chunk
          }
        }
        // flush tails: a tail held at stream end is real content, not
        // something to drop — text re-emits on its stream index, tool-call
        // argument tails re-emit as a delta on the same call
        for (const [idx, r] of textRestorers) {
          const tail = r.flush()
          fold(r)
          if (tail) yield { type: 'text-delta', index: idx, text: tail } as AnyChunk
        }
        for (const e of argRestorers.values()) {
          const tail = e.r.flush()
          fold(e.r)
          if (tail) yield { type: 'tool-call-delta', id: e.id, index: e.index, argumentsDelta: tail } as AnyChunk
        }
        if (recordId > 0) {
          self.records.bumpRestored(recordId, restoredTotal)
          for (const [ph, n] of valueRestores) self.records.bumpValueRestored(recordId, ph, n)
        }
      } finally { /* per-block restorers are local to the loop */ }
    })(this)
  }

  // ---- Remote API (gateway /api SRC; owner-only) ----

  list(sessionId: string): Promise<unknown> {
    return Promise.resolve(this.records.list(sessionId || undefined))
  }

  clear(sessionId: string): Promise<unknown> {
    this.records.clear(sessionId || undefined)
    return Promise.resolve({ ok: true })
  }

  /** Preview: mask arbitrary text without remembering values or recording. */
  preview(text: string): Promise<unknown> {
    const hits: RedactionRecordValue[] = []
    const out = maskText(text, this.engineOptions(), this.store, (hit, _v, p) => {
      hits.push({ placeholder: hit.placeholder, kind: hit.kind, by: hit.by, head: hit.head, len: hit.len, n: 1, action: hit.action, path: p, restored: 0 })
    }, 'preview', false)
    return Promise.resolve({ text: out.text, replaced: out.replaced, values: hits })
  }
}

// Typert Gateway SRC discovery: expose list/clear/preview through /api.
Object.defineProperty(RedactionService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: 'list', invocation: Object.freeze({ kind: 'direct' }) },
      { method: 'clear', invocation: Object.freeze({ kind: 'direct' }) },
      { method: 'preview', invocation: Object.freeze({ kind: 'direct' }) },
    ]),
  }),
})

export function apply(ctx: Context, config: RedactionConfig): void {
  ctx.plugin(RedactionService, config)
}
