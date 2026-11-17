/**
 * Redaction engine: span scanning + merging (magpie redact.go apply) and
 * streaming-friendly restoration (magpie writer.go hold semantics).
 */
import type { Hit, MaskResult, RestoreResult, Span } from './types.ts'
import { CATEGORY_DEFAULT, RULES, type RuleDef } from './rules.ts'
import type { PlaceholderStore } from './store.ts'

export interface EngineOptions {
  secrets: boolean
  personal: boolean
  /** category toggles, keyed by kind ('EMAIL') or category id ('ssn');
   *  magpie Categories defaults apply to ids not set (CATEGORY_DEFAULT) */
  kinds: Record<string, boolean>
  words: string[]
  /** magpie WordsAnyCase: match the user's words in any case */
  wordsAnyCase?: boolean
  /** magpie WordsWhole: match words only as whole words */
  wordsWhole?: boolean
  rules: Array<{ kind: string; prefix?: string; regex?: string }>
  allow: string[]
  actions: Record<string, 'warn' | 'block'>
}

/** Placeholder exactly as the engine writes it. */
export const PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g

function covers(rule: RuleDef, o: EngineOptions): boolean {
  const cat = rule.cat ?? ''
  if (cat === '') return o.secrets
  if (!o.personal) return false
  if (cat === 'personal') return o.kinds[rule.kind] ?? true
  return o.kinds[cat] ?? CATEGORY_DEFAULT[cat] ?? false
}

function builtCustomRules(rules: EngineOptions['rules']): RuleDef[] {
  const out: RuleDef[] = []
  for (const r of rules) {
    if (r.prefix) {
      const esc = r.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out.push({ id: `custom-prefix:${r.prefix}`, kind: r.kind, cat: '', re: new RegExp(`${esc}[A-Za-z0-9_-]{6,}`) })
    } else if (r.regex) {
      out.push({ id: `custom-regex:${r.regex}`, kind: r.kind, cat: '', re: new RegExp(r.regex) })
    }
  }
  return out
}

function ruleSpans(text: string, o: EngineOptions): Span[] {
  const allow = new Set(o.allow.map(a => a.toLowerCase()))
  const spans: Span[] = []
  // magpie split: a groups rule's match range swallows an EMAIL span that
  // covers it whole (user@host is not an email)
  const splits: Array<[number, number]> = []
  for (const rule of RULES) {
    if (!covers(rule, o)) continue
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g')
    let m: RegExpExecArray | null
    let prevStart = -1
    while ((m = re.exec(text)) !== null) {
      if (rule.groups) {
        // magpie `groups`: each capture group is a value of its own kind
        // `at` sees the whole match once (a host group's "before" ends in
        // @, which a verb-prefix check would misread)
        if (rule.at && !rule.at(text, m.index, m.index + m[0].length)) {
          re.lastIndex = m.index + 1
          continue
        }
        let took = false
        let cursor = m.index
        rule.groups.forEach((kind, gi) => {
          const g = m![gi + 1]
          if (g === undefined) return
          const start = text.indexOf(g, cursor)
          if (start < 0) return
          cursor = start + g.length
          if (allow.has(g) || allow.has(g.toLowerCase())) return
          if (rule.groupOK?.[gi] && !rule.groupOK[gi](g)) return
          spans.push({ start, end: cursor, kind, by: 'rule' })
          took = true
        })
        if (took) splits.push([m.index, m.index + m[0].length])
        if (re.lastIndex === m.index) re.lastIndex++
        continue
      }
      let value: string | undefined
      if (rule.anyGroup === true) value = m.slice(1).find(g => g !== undefined)
      else value = rule.group === true ? m[1] : m[0]
      if (!value || allow.has(value) || allow.has(value.toLowerCase())) {
        if (re.lastIndex === m.index) re.lastIndex++
        continue
      }
      const offset = rule.group === true || rule.anyGroup === true ? m[0].indexOf(value) : -1
      let start = (m.index) + Math.max(offset, 0)
      let end = start + value.length
      if (rule.fix) {
        const fixed = rule.fix(text, start, end)
        if (!fixed) continue
        ;[start, end] = fixed
        value = text.slice(start, end)
        if (!value || allow.has(value.toLowerCase())) continue
      }
      if (rule.ok && !rule.ok(value)) continue
      if (rule.at && !rule.at(text, start, end)) {
        // context rejected this candidate; resume from the match start so
        // an overlapping candidate (a lazy prefix swallowing an earlier
        // user@host in front of git@github.com) still gets its chance
        re.lastIndex = m.index + 1
        continue
      }
      if (start === prevStart) { re.lastIndex = Math.max(re.lastIndex, start + 1); continue }
      prevStart = start
      spans.push({
        start,
        end,
        kind: rule.kind,
        by: 'rule',
      })
      if (re.lastIndex === m.index) re.lastIndex++
    }
  }
  // magpie split: drop EMAIL spans swallowed whole by a groups match
  for (const [a, b] of splits) {
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i]
      if (s.kind === 'EMAIL' && s.start >= a && s.end <= b) spans.splice(i, 1)
    }
  }
  for (const rule of builtCustomRules(o.rules)) {
    const re = new RegExp(rule.re.source, rule.re.flags + (rule.re.flags.includes('g') ? '' : 'g'))
    for (const m of text.matchAll(re)) {
      const value = m[0]
      if (!allow.has(value) && !allow.has(value.toLowerCase())) {
        spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + value.length, kind: rule.kind, by: 'yours' })
      }
    }
  }
  return spans
}

/** magpie wholeWord: the word stands alone — no word byte on either side,
 *  and no digit-dot-digit run growing it (123456 inside 0.123456.78). */
function wholeWord(s: string, a: number, b: number): boolean {
  const wordByte = (c: string) => /[A-Za-z0-9_]/.test(c)
  const first = s[a]
  const last = s[b - 1]
  if (wordByte(first) && a > 0) {
    const r = s[a - 1]
    if (wordByte(r)) return false
    if (/[0-9]/.test(first) && r === '.') {
      if (a - 2 >= 0 && /[0-9]/.test(s[a - 2])) return false
    }
  }
  if (wordByte(last) && b < s.length) {
    const r = s[b]
    if (wordByte(r)) return false
    if (/[0-9]/.test(last) && r === '.') {
      if (b + 1 < s.length && /[0-9]/.test(s[b + 1])) return false
    }
  }
  return true
}

function wordSpans(text: string, o: EngineOptions): Span[] {
  const allow = new Set(o.allow.map(a => a.toLowerCase()))
  const spans: Span[] = []
  for (const w of o.words) {
    if (!w) continue
    if (o.wordsAnyCase) {
      const lowText = text.toLowerCase()
      const lowW = w.toLowerCase()
      let i = lowText.indexOf(lowW)
      while (i !== -1) {
        if (!allow.has(text.slice(i, i + w.length).toLowerCase())
          && (!o.wordsWhole || wholeWord(text, i, i + w.length))) {
          spans.push({ start: i, end: i + w.length, kind: 'WORD', by: 'word' })
        }
        i = lowText.indexOf(lowW, i + Math.max(w.length, 1))
      }
    } else {
      let i = text.indexOf(w)
      while (i !== -1) {
        if (!allow.has(text.slice(i, i + w.length)) && !allow.has(text.slice(i, i + w.length).toLowerCase())
          && (!o.wordsWhole || wholeWord(text, i, i + w.length))) {
          spans.push({ start: i, end: i + w.length, kind: 'WORD', by: 'word' })
        }
        i = text.indexOf(w, i + w.length)
      }
    }
  }
  return spans
}

/** magpie apply(): the first to start, and of those the longest, wins;
 *  overlapping drops, nothing inside an existing placeholder. */
export function mergeSpans(text: string, spans: Span[]): Span[] {
  const out: Span[] = []
  // stable sort: start asc, then end desc — of two the same, the rule found
  // first, so a value's placeholder is the same every time (magpie apply)
  const sorted = [...spans].sort((a, b) => (a.start - b.start) || (b.end - a.end))
  let next = 0
  for (const s of sorted) {
    if (s.end <= s.start || s.end > text.length) continue
    if (s.start < next) continue
    next = s.end
    out.push(s)
  }
  return out
}

/**
 * Replace merged spans with placeholders. Existing placeholder spans are
 * copied verbatim; hits are reported without plaintext (value only reaches
 * the store, which the caller owns).
 */
export function maskText(
  text: string,
  o: EngineOptions,
  store: PlaceholderStore,
  onHit?: (hit: Hit, value: string, path: string) => void,
  path = '',
  remember = true,
): MaskResult {
  const spans = mergeSpans(text, [...ruleSpans(text, o), ...wordSpans(text, o)])
  if (spans.length === 0) return { text, replaced: 0 }
  let out = ''
  let last = 0
  let replaced = 0
  for (const s of spans) {
    if (s.kind === '') continue // pre-existing placeholder, keep as-is
    if (s.by === 'known') continue
    const value = text.slice(s.start, s.end)
    const action = o.actions[s.kind] ?? ''
    const placeholder = remember && action !== 'warn' ? store.placeholder(s.kind, value) : store.tag(s.kind, value)
    onHit?.({ kind: s.kind, by: s.by, placeholder, action, head: value.slice(0, 3), len: [...value].length }, value, path)
    if (action === 'warn') continue
    out += text.slice(last, s.start) + placeholder
    last = s.end
    replaced++
  }
  out += text.slice(last)
  return { text: out, replaced }
}

/** One placeholder-shaped token: braced `{{KIND_tag}}` or a bare
 *  `KIND_tag` body the model wrote without braces (magpie placeholderBody). */
const PLACEHOLDER_TOKEN_RE = /\{\{([A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8})\}\}|([A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8})/g

/** Canonical braced keys to try for one case-drifted body: kind as written,
 *  upper and lower; the base32 tag is always lower-cased — store keys are
 *  generated with a lowercase tag, so an uppercased query never hits. */
function bodyCandidates(m: string): string[] {
  const i = m.lastIndexOf('_')
  if (i < 1 || m.length - i !== 9) return []
  const tag = m.slice(i + 1)
  if (!/^[A-Za-z2-7]{8}$/.test(tag)) return []
  const kind = m.slice(0, i)
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(kind)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of [kind, kind.toUpperCase(), kind.toLowerCase()]) {
    const b = `{{${k}_${tag.toLowerCase()}}}`
    if (!seen.has(b)) { seen.add(b); out.push(b) }
  }
  return out
}

/** Replace placeholders — braced or bare, canonical or case-drifted — with
 *  their remembered values. */
export function restoreText(text: string, store: PlaceholderStore): RestoreResult {
  const counts = new Map<string, number>()
  let restored = 0
  const out = text.replace(PLACEHOLDER_TOKEN_RE, (m, braced: string | undefined, bare: string | undefined) => {
    const inner = braced ?? bare
    if (inner === undefined) return m
    for (const key of bodyCandidates(inner)) {
      const v = store.value(key)
      if (v !== undefined) {
        restored++
        counts.set(key, (counts.get(key) ?? 0) + 1)
        return v
      }
    }
    return m
  })
  return { text: out, restored, counts }
}

/**
 * Streaming restore with hold semantics (magpie writer.go): a trailing
 * fragment that could still complete into a placeholder is held back until
 * the next chunk; flush() releases the tail at stream end.
 */
export class StreamRestorer {
  private buf = ''
  private done = false
  restored = 0
  readonly counts = new Map<string, number>()
  private readonly store: PlaceholderStore

  constructor(store: PlaceholderStore) {
    this.store = store
  }

  push(chunk: string): string {
    if (this.done) throw new Error('StreamRestorer already flushed')
    this.buf += chunk
    const { text, restored, counts } = restoreText(this.buf, this.store)
    this.restored += restored
    for (const [k, v] of counts) this.counts.set(k, (this.counts.get(k) ?? 0) + v)
    const hold = holdLen(this.buf)
    this.buf = this.buf.slice(this.buf.length - hold)
    return text.slice(0, text.length - hold)
  }

  flush(): string {
    this.done = true
    const { text, restored, counts } = restoreText(this.buf, this.store)
    this.restored += restored
    for (const [k, v] of counts) this.counts.set(k, (this.counts.get(k) ?? 0) + v)
    this.buf = ''
    return text
  }
}

/** How many trailing chars could still grow into a placeholder. */
export function holdLen(s: string): number {
  for (let n = Math.min(s.length, 40); n > 0; n--) {
    const tail = s.slice(-n)
    // braced partial; kind run may be case-drifted by the model
    if (/^\{\{[A-Za-z][A-Za-z0-9_]{0,30}(_[a-z2-7]{0,8})?$/.test(tail)) return n
    // bare-body partial; kind run may be case-drifted too
    if (/^[A-Za-z][A-Za-z0-9_]{1,30}_[a-z2-7]{0,8}$/.test(tail)) return n
  }
  return 0
}
