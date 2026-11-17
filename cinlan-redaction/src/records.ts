/**
 * In-memory ring buffer of redaction records. Records carry no plaintext
 * values, EXCEPT each hit's `before`/`after`: ≤200-char snippets of the
 * scanned field around the replacement, kept for the detail view's original
 * vs. masked comparison. They live in this process's memory only (cleared
 * with the buffer or by `clear()`), never persisted to disk, never sent to
 * the model provider — the Remote API exposes them only to the local UI.
 */
import type { RedactionRecord } from './types.ts'

export class RecordBuffer {
  private nextId = 1
  private turn = 0
  private readonly items: RedactionRecord[] = []

  constructor(private readonly capacity = 1000) {}

  nextTurn(): number {
    return ++this.turn
  }

  add(record: Omit<RedactionRecord, 'id' | 'time'>): RedactionRecord {
    const full: RedactionRecord = { ...record, id: this.nextId++, time: new Date().toISOString() }
    this.items.push(full)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
    return full
  }

  list(sessionId?: string): RedactionRecord[] {
    const out = sessionId === undefined ? [...this.items] : this.items.filter(r => r.sessionId === sessionId)
    return out.reverse()
  }

  bumpRestored(id: number, restored: number): void {
    const r = this.items.find(x => x.id === id)
    if (r) r.restored += restored
  }

  bumpValueRestored(id: number, placeholder: string, n: number): void {
    const r = this.items.find(x => x.id === id)
    const v = r?.values.find(x => x.placeholder === placeholder)
    if (v) v.restored += n
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.items.length = 0
    } else {
      const keep = this.items.filter(r => r.sessionId !== sessionId)
      this.items.length = 0
      this.items.push(...keep)
    }
  }

  get size(): number {
    return this.items.length
  }
}
