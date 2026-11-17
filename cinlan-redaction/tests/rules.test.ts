import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaceholderStore } from '../src/store.ts'
import { maskText, restoreText, StreamRestorer, mergeSpans } from '../src/engine.ts'
import type { EngineOptions } from '../src/engine.ts'

const base: EngineOptions = {
  secrets: true, personal: true, kinds: {}, words: [], rules: [], allow: [], actions: {},
}
const store = () => new PlaceholderStore()

test('API keys are masked with stable placeholders', () => {
  const s = store()
  const r1 = maskText('key: sk-abcdefghijklmnopqrstuvwxyz123456', base, s)
  assert.match(r1.text, /\{\{API_KEY_[a-z2-7]{8}\}\}/)
  assert.equal(r1.replaced, 1)
  const r2 = maskText('again sk-abcdefghijklmnopqrstuvwxyz123456 ok', base, s)
  assert.equal(r2.text, r1.text.replace('key: ', 'again ') + ' ok')
})

test('placeholder format is HMAC-kind-tagged', () => {
  const s = store()
  const { text } = maskText('AKIAIOSFODNN7EXAMPLE', base, s)
  const m = /\{\{(API_KEY_[a-z2-7]{8})\}\}/.exec(text)
  assert.ok(m)
  const again = maskText('AKIAIOSFODNN7EXAMPLE', base, s)
  assert.ok(again.text.includes(m![1]))
})

test('private key block is masked whole', () => {
  const s = store()
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----'
  const { text, replaced } = maskText(`sign with ${pem} please`, base, s)
  assert.equal(replaced, 1)
  assert.ok(!text.includes('MIIEow'))
})

test('password in URL is masked, host survives', () => {
  const s = store()
  const { text } = maskText('postgres://admin:hunter22secret@db.internal:5432/x', base, s)
  assert.ok(text.includes('postgres://admin:{{PASSWORD_'))
  assert.ok(!text.includes('hunter22secret'))
})

test('CJK password assignment is masked', () => {
  const s = store()
  const { text } = maskText('数据库密码：Sup3rS3cret!', base, s)
  assert.ok(text.includes('数据库密码：{{PASSWORD_'))
})

test('email / phone / id card / bank card under personal', () => {
  const s = store()
  const { text } = maskText('联系 a.b@corp.cn 或 13812345678', base, s)
  assert.ok(text.includes('{{EMAIL_'))
  assert.ok(text.includes('{{PHONE_'))
})

test('personal off leaves email alone', () => {
  const s = store()
  const r = maskText('a.b@corp.cn', { ...base, personal: false }, s)
  assert.equal(r.text, 'a.b@corp.cn')
})

test('kinds toggle can disable one personal kind', () => {
  const s = store()
  const r = maskText('a.b@corp.cn', { ...base, kinds: { EMAIL: false } }, s)
  assert.equal(r.text, 'a.b@corp.cn')
})

test('allow list passes the whole value through', () => {
  const s = store()
  const key = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const r = maskText(`key: ${key}`, { ...base, allow: [key] }, s)
  assert.equal(r.text, `key: ${key}`)
})

test('custom words and custom rules mask with their finders', () => {
  const s = store()
  const r = maskText('project nightjar on gw_abc123def456', { ...base, secrets: false, personal: false, words: ['nightjar'], rules: [{ kind: 'GATEWAY_KEY', prefix: 'gw_' }] }, s)
  assert.ok(r.text.includes('{{WORD_'))
  assert.ok(r.text.includes('{{GATEWAY_KEY_'))
})

test('restore returns the original value', () => {
  const s = store()
  const masked = maskText('secret is sk-abcdefghijklmnopqrstuvwxyz123456 done', base, s).text
  const back = restoreText(`reply ${masked} end`, s)
  assert.ok(back.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'))
  assert.equal(back.restored, 1)
})

test('stream restorer holds a split placeholder across chunks', () => {
  const s = store()
  const masked = s.placeholder('API_KEY', '{{API_KEY_vemf43gc}}')
  const r = new StreamRestorer(s)
  const a = r.push(`x ${masked.slice(0, 12)}`)
  const b = r.push(`${masked.slice(12)} y`)
  const tail = r.flush()
  assert.equal(a + b + tail, `x {{API_KEY_vemf43gc}} y`)
  assert.equal(r.restored, 1)
})

test('mergeSpans drops overlaps and keeps placeholders intact', () => {
  const spans = [
    { start: 0, end: 10, kind: 'A', by: 'rule' as const },
    { start: 5, end: 15, kind: 'B', by: 'rule' as const },
  ]
  const merged = mergeSpans('x'.repeat(20), spans)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].kind, 'A')
})

test('wordsAnyCase matches case-drifted words', () => {
  const s = store()
  const o: EngineOptions = { ...base, secrets: false, personal: false, words: ['Nightjar'], wordsAnyCase: true }
  const { text, replaced } = maskText('nightjar and NIGHTJAR and Nightjar', o, s)
  assert.equal(replaced, 3)
  assert.ok(!text.includes('nightjar'))
})

test('wordsWhole skips embedded occurrences', () => {
  const s = store()
  const o: EngineOptions = { ...base, secrets: false, personal: false, words: ['ABC', '123456'], wordsWhole: true }
  const { text, replaced } = maskText('ABC IS here, XABCD stays, 0.123456.78 stays', o, s)
  assert.equal(replaced, 1)
  assert.ok(text.includes('XABCD'))
  assert.ok(text.includes('0.123456.78'))
})

test('allow list matches in any case', () => {
  const s = store()
  const o: EngineOptions = { ...base, words: ['Acme'], allow: ['acme'] }
  const { replaced } = maskText('acme acme acme', o, s)
  assert.equal(replaced, 0)
})

test('case-drifted placeholders restore in every form', () => {
  const s = store()
  const masked = maskText('key sk-abcdefghijklmnopqrstuvwxyz123 ok', base, s).text
  const body = masked.slice(2, -2) // bare canonical body KIND_tag
  const drifts = [
    body,                        // bare body, exactly as written
    body.toLowerCase(),          // model lower-cased the kind
    body.toUpperCase(),          // model upper-cased everything
    `{{${body.toLowerCase()}}}`, // braced with a lower-cased kind
  ]
  for (const d of drifts) {
    const back = restoreText(`x ${d} y`, s)
    assert.ok(back.text.includes('sk-abcdefghijklmnopqrstuvwxyz123'), `drift ${d} restored`)
    assert.equal(back.restored, 1)
  }
})

test('preview does not pollute the placeholder table', () => {
  const s = store()
  // remember=false is the preview path (src/index.ts RedactionService.preview)
  maskText('key sk-abcdefghijklmnopqrstuvwxyz123 ok', base, s, undefined, '', false)
  assert.equal(s.size, 0)
  const back = restoreText('x {{API_KEY_2y3r2tew}} y', s)
  assert.equal(back.restored, 0)
  assert.ok(back.text.includes('{{API_KEY_2y3r2tew}}'))
})

// sample values (test fixtures, not real credentials)

const MAC_ADDR = '3c:22:fb:7a:91:04'
const SERIAL_NO = 'C02XW2MBJHD3'
const IBAN_OK = 'GB29 NWBK 6016 1331 9268 19'
const IBAN_BAD = 'GB29 NWBK 6016 1331 9268 20' // bad checksum
const SSH_LINE = 'ssh deploy@build-01.acme-lab.cn'
const BUCKET_URI = 's3://prod-backups-x7f2'
const DOB = '1990-03-05'

test('ssn / mac / serial follow their category toggles', () => {
  const s = store()
  const on: EngineOptions = { ...base, secrets: false, personal: true }
  const hit = maskText(`ssn: {{SSN_x6gk7bd5}}, mac ${MAC_ADDR}, S/N: ${SERIAL_NO}`, on, s)
  assert.ok(hit.text.includes('{{SSN_'))
  assert.ok(hit.text.includes('{{MAC_'))
  assert.ok(hit.text.includes('{{SERIAL_'))
  const off: EngineOptions = { ...on, kinds: { ssn: false, mac: false, serial: false } }
  const kept = maskText(`ssn: {{SSN_x6gk7bd5}}, mac ${MAC_ADDR}, S/N: ${SERIAL_NO}`, off, store())
  assert.equal(kept.replaced, 0)
})

test('ssn ranges and iban checksum turn examples away', () => {
  const s = store()
  const on: EngineOptions = { ...base, secrets: false, personal: true }
  assert.equal(maskText('000-12-3456 078-05-1120 666-09-9999', on, s).replaced, 0)
  assert.equal(maskText(`pay to ${IBAN_OK}`, on, s).replaced, 1)
  assert.equal(maskText(`pay to ${IBAN_BAD}`, on, store()).replaced, 0)
})

test('public ip only: private, resolver and version lookalikes stay', () => {
  const s = store()
  const on: EngineOptions = { ...base, secrets: false, personal: true, kinds: { ip: true } }
  const { text, replaced } = maskText('edge 203.0.114.9, doc 203.0.113.7, lan 192.168.1.1, dns 8.8.8.8, v1.2.3.4', on, s)
  assert.equal(replaced, 1)
  assert.ok(text.includes('{{IP_'))
  assert.ok(text.includes('203.0.113.7'))
  assert.ok(text.includes('192.168.1.1'))
  assert.ok(text.includes('8.8.8.8'))
  assert.ok(text.includes('v1.2.3.4'))
})

test('home folder user names follow the home category (off by default)', () => {
  const s = store()
  const off: EngineOptions = { ...base, secrets: false, personal: true }
  assert.equal(maskText('/Users/alice7/code/x', off, s).replaced, 0)
  const on: EngineOptions = { ...base, secrets: false, personal: true, kinds: { home: true } }
  const { text } = maskText('/Users/alice7/code/x', on, store())
  assert.ok(text.includes('{{USERNAME_'))
  assert.ok(!text.includes('alice7'))
})

test('userhost: ssh user@host masks, git@github.com stays', () => {
  const s = store()
  const on: EngineOptions = { ...base, secrets: false, personal: true, kinds: { userhost: true } }
  const { text } = maskText('ssh deploy_bot@build-01.acme-lab.cn and git@github.com:org/repo.git', on, s)
  // magpie splits user@host into USERNAME + HOSTNAME placeholders
  assert.ok(text.includes('{{USERNAME_'))
  assert.ok(text.includes('{{HOSTNAME_'))
  assert.ok(text.includes('git@github.com'))
})

test('bucket uri masks, example bucket stays', () => {
  const s = store()
  const on: EngineOptions = { ...base, secrets: false, personal: true, kinds: { bucket: true } }
  const { text } = maskText(`${BUCKET_URI} and s3://my-bucket`, on, s)
  assert.ok(text.includes('{{BUCKET_'))
  assert.ok(text.includes('s3://my-bucket'))
})

test('birthday needs its label, a bare date stays', () => {
  const s = store()
  const on: EngineOptions = { ...base, secrets: false, personal: true }
  const { text, replaced } = maskText(`birthday: ${DOB}, released 2024-01-15`, on, s)
  assert.equal(replaced, 1)
  assert.ok(text.includes('2024-01-15'))
})

