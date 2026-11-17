/**
 * Placeholder store: placeholder → value map with a persistent HMAC key.
 * Ported from magpie's global placeholder table (redact.go): same value →
 * same placeholder across turns and restarts (prompt-cache friendly); LRU
 * capacity 200k with half-eviction; plaintext lives only in this process.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const MAX_VALUES = 200_000

function base32_8(buf: Buffer): string {
  // first 8 bytes → base32 chars, take 8 (5-bit groups over a 64-bit prefix)
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < 8 && out.length < 8; i++) {
    value = (value << 8) | buf[i]
    bits += 8
    while (bits >= 5 && out.length < 8) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

export class PlaceholderStore {
  private key: Buffer
  private readonly values = new Map<string, string>()
  private readonly used = new Map<string, number>()
  private clock = 0

  constructor(keyPath?: string) {
    this.key = this.loadKey(keyPath)
  }

  private loadKey(keyPath?: string): Buffer {
    if (keyPath) {
      try {
        const b = readFileSync(keyPath)
        if (b.length >= 32) return b.subarray(0, 32)
      } catch { /* fall through: generate */ }
      const k = randomBytes(32)
      try {
        mkdirSync(dirname(keyPath), { recursive: true })
        writeFileSync(keyPath, k, { mode: 0o600 })
      } catch { /* in-memory only if persist fails */ }
      return k
    }
    return randomBytes(32)
  }

  /** Deterministic placeholder tag; does not remember the value. */
  tag(kind: string, value: string): string {
    const h = createHmac('sha256', this.key).update(kind + '\0' + value).digest()
    return `{{${kind}_${base32_8(h)}}}`
  }

  /** Tag AND remember the value for response restoration. */
  placeholder(kind: string, value: string): string {
    const p = this.tag(kind, value)
    if (!this.values.has(p)) {
      this.makeRoom()
      this.values.set(p, value)
    }
    this.used.set(p, ++this.clock)
    return p
  }

  /** Lookup for restoration; absent entries restore nothing. */
  value(placeholder: string): string | undefined {
    const v = this.values.get(placeholder)
    if (v !== undefined) this.used.set(placeholder, ++this.clock)
    return v
  }

  /** True when the canonical placeholder for a value is already tracked. */
  has(kind: string, value: string): boolean {
    return this.values.has(this.tag(kind, value))
  }

  get size(): number {
    return this.values.size
  }

  private makeRoom(): void {
    if (this.values.size < MAX_VALUES) return
    const entries = [...this.values.keys()].sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0))
    for (const p of entries.slice(0, Math.floor(entries.length / 2))) {
      this.values.delete(p)
      this.used.delete(p)
    }
  }
}
