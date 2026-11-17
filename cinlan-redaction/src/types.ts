/** Placeholder suffix length: HMAC-SHA256 digest[0..8] base32 (no padding, lower case). */
export const PLACEHOLDER_TAG_LEN = 8

/** A value found by one finder channel, ready for a placeholder. */
export interface Span {
  start: number
  end: number
  kind: string
  by: 'rule' | 'word' | 'yours' | 'known'
}

/** Record-facing view of one found value; never carries the value itself. */
export interface Hit {
  kind: string
  by: Span['by']
  placeholder: string
  action: '' | 'warn' | 'block'
  head: string
  len: number
}

/** One per-request redaction record. No plaintext values; hit entries carry
 *  only ≤2000-char before/after field snippets for the detail view (in-memory
 *  only — see records.ts). */
export interface RedactionRecord {
  id: number
  sessionId: string
  turn: number
  provider: string
  model: string
  bytes: number
  values: RedactionRecordValue[]
  replaced: number
  tookMs: number
  blocked: boolean
  segments?: RedactionSegment[]
  restored: number
  time: string
}

/** Detail view 的字段段清单：只记 path/bytes/changed/role，不落文本。 */
export interface RedactionSegment {
  path: string
  bytes: number
  changed: boolean
  role?: string
}

export interface RedactionRecordValue {
  placeholder: string
  kind: string
  by: Span['by']
  head: string
  len: number
  n: number
  action: Hit['action']
  path: string
  restored: number
  /** original text (first 2000 chars) for the detail view */
  before?: string
  /** masked text (first 2000 chars) for the detail view */
  after?: string
}

/** Result of scanning one text run. */
export interface MaskResult {
  text: string
  replaced: number
}

/** Restore-mode output with per-placeholder restore counts. */
export interface RestoreResult {
  text: string
  restored: number
  counts: Map<string, number>
}
