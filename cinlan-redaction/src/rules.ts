/**
 * Built-in rule table, ported from magpie internal/redact/redact.go +
 * more.go. Secrets stay under `cat: ''` (the secrets master switch);
 * personal data uses magpie's Categories: core kinds are gated by
 * `personal`, every other cat id is gated by `kinds[cat]` with the
 * category default in CATEGORY_DEFAULT. magpie's marker/fold prefilter is
 * a perf trick and is skipped — patterns run in full; `fix` predicates
 * (ibanAt, homeAt) shorten a match and are honored.
 */

export interface RuleDef {
  id: string
  kind: string
  /** value; group 1 when set, else the whole match */
  group?: boolean
  /** take the first capture group that matched (magpie anyGroup) */
  anyGroup?: boolean
  /** magpie `groups`: capture groups, each masked as a value of its own
   *  with kinds[i]; groupOK[i] vets each (user@host → USERNAME+HOSTNAME) */
  groups?: string[]
  groupOK?: Array<(v: string) => boolean>
  re: RegExp
  /** category gate: '' (default) = secrets; 'personal' = core personal;
   *  anything else = a category id under kinds{} (see CATEGORY_DEFAULT) */
  cat?: '' | 'personal' | string
  ok?: (v: string) => boolean
  /** context check on the match position (magpie `at` predicates) */
  at?: (text: string, start: number, end: number) => boolean
  /** magpie `fix`: verifies and may shorten the match; returns [a, b] */
  fix?: (text: string, start: number, end: number) => [number, number] | null
}

/** magpie Categories defaults (more.go): what kinds[] inherits. */
export const CATEGORY_DEFAULT: Record<string, boolean> = {
  ssn: true,
  passport: true,
  iban: true,
  birthday: true,
  mac: true,
  serial: true,
  home: false,
  userhost: false,
  ip: false,
  bucket: false,
}

/** Category ids the settings UI lists under personal data, in order. */
export const CATEGORY_IDS = ['ssn', 'passport', 'iban', 'birthday', 'mac', 'serial', 'home', 'userhost', 'ip', 'bucket'] as const

/** magpie notASlug: has a separator inside or is not a plain word. */
export function notASlug(v: string): boolean {
  if (/[-_/.]/.test(v.slice(1, -1))) return true
  return !/^[A-Za-z]+$/.test(v) || v === v.toLowerCase() || v === v.toUpperCase()
}

/** magpie keyValue: letters and digits both, or >= 16 chars not all digits. */
export function keyValue(v: string): boolean {
  const letter = /[A-Za-z]/.test(v)
  return letter && (/\d/.test(v) || v.length >= 16)
}

/** magpie secretValue: keyValue, digits-only, or a private-key-looking body. */
export function secretValue(v: string): boolean {
  if (/^[0-9]{8,}$/.test(v)) return true
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v)) return true
  return keyValue(v)
}

/** magpie headerValue: not a placeholder / variable / obviously masked out. */
export function headerValue(v: string): boolean {
  if (v.includes('{{')) return false
  if (/^[$<{*]/.test(v)) return false
  return v.replace(/[*xX.]/g, '') !== ''
}

/** Luhn check for bank cards. */
export function luhn(v: string): boolean {
  const s = v.replace(/[ -]/g, '')
  if (s.length < 12) return false
  let sum = 0
  let dbl = false
  for (let i = s.length - 1; i >= 0; i--) {
    const d = s.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    let x = d
    if (dbl) {
      x *= 2
      if (x > 9) x -= 9
    }
    sum += x
    dbl = !dbl
  }
  return sum % 10 === 0
}

/** Chinese ID card checksum. */
export function chineseID(v: string): boolean {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const codes = '10X98765432'
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (v.charCodeAt(i) - 48) * w[i]
  return codes[sum % 11] === v[17].toUpperCase()
}

// ---- magpie more.go predicates ----

/** magpie ssnOK. */
export function ssnOK(v: string): boolean {
  const d = v.replace(/[- ]/g, '')
  if (d.length !== 9 || d.startsWith('000') || d.startsWith('666') || d[0] === '9' || d.slice(3, 5) === '00' || d.slice(5) === '0000') return false
  if (d === '123456789' || d === '078051120' || d === '219099999') return false
  return d.split('').some(c => c !== d[0])
}

/** magpie passportOK: five or more digits, not one repeated char. */
export function passportOK(v: string): boolean {
  const digits = (v.match(/[0-9]/g) ?? []).length
  return digits >= 5 && v.split('').some(c => c !== v[0])
}

/** magpie ibanLen. */
const IBAN_LEN: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
}

/** magpie ibanOK: country length + mod 97. */
export function ibanOK(v: string): boolean {
  const s = v.replace(/ /g, '')
  if (s.length < 4) return false
  const n = IBAN_LEN[s.slice(0, 2)]
  if (n === undefined || n !== s.length) return false
  const r = s.slice(4) + s.slice(0, 4)
  let m = 0
  for (const c of r) {
    if (c >= '0' && c <= '9') m = (m * 10 + c.charCodeAt(0) - 48) % 97
    else if (c >= 'A' && c <= 'Z') m = (m * 100 + c.charCodeAt(0) - 55) % 97
    else return false
  }
  return m === 1
}

/** magpie ibanAt: the IBAN at s[a:b], or the one before a trailing caps word. */
export function ibanAt(s: string, a: number, b: number): [number, number] | null {
  for (;;) {
    if (ibanOK(s.slice(a, b))) return [a, b]
    const i = s.slice(a, b).lastIndexOf(' ')
    if (i < 0) return null
    b = a + i
  }
}

/** magpie dateOK: a real date in 1900–2099, over a year old. */
export function dateOK(v: string): boolean {
  const ns = v.match(/\d+/g)
  if (!ns) return false
  const num = (s: string) => parseInt(s, 10)
  const yearAgo = Date.now() - 365 * 24 * 3600 * 1000
  const valid = (y: number, m: number, d: number) =>
    y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31 &&
    new Date(y, m - 1, d).getTime() < yearAgo
  if (ns.length === 2) {
    const l = v.toLowerCase()
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    for (let i = 0; i < months.length; i++) {
      if (l.includes(months[i])) {
        let d = num(ns[0]); let y = num(ns[1])
        if (ns[0].length === 4) { const t = d; d = y; y = t }
        return valid(y, i + 1, d)
      }
    }
    return false
  }
  if (ns.length !== 3) return false
  if (ns[0].length === 4) return valid(num(ns[0]), num(ns[1]), num(ns[2]))
  const p = num(ns[0]); const q = num(ns[1]); const y = num(ns[2])
  return valid(y, p, q) || valid(y, q, p)
}

/** magpie macOK: no docs/examples, no broadcast, has hex letters. */
export function macOK(v: string): boolean {
  const l = v.toLowerCase().replace(/-/g, ':')
  if (['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '00:11:22:33:44:55', 'aa:bb:cc:dd:ee:ff',
    '01:23:45:67:89:ab', '12:34:56:78:9a:bc', 'xx:xx:xx:xx:xx:xx'].includes(l)) return false
  return /[abcdef]/.test(l)
}

/** magpie serialOK: 6+ chars, has a digit, not one repeated char. */
export function serialOK(v: string): boolean {
  return v.length >= 6 && /[0-9]/.test(v) && v.split('').some(c => c !== v[0])
}

/** magpie notNames: folder names that are no one's user name. */
const NOT_NAMES = new Set([
  'shared', 'public', 'guest', 'default', 'default user', 'all users',
  'user', 'username', 'user_name', 'yourname', 'your-name', 'your_name', 'yourusername',
  'you', 'me', 'name', 'example', 'foo', 'bar', 'someone', 'john', 'jdoe',
  'runner', 'node', 'vscode', 'codespace', 'linuxbrew', '...',
])

/** magpie homeAt: drop a trailing sentence stop; skip the known non-names. */
export function homeAt(s: string, a: number, b: number): [number, number] | null {
  while (b > a && s[b - 1] === '.') b--
  if (b === a || s[a] === '.' || NOT_NAMES.has(s.slice(a, b).toLowerCase())) return null
  return [a, b]
}

/** magpie notUsers: service users and chat filler. */
const NOT_USERS = new Set([
  'git', 'root', 'ec2-user', 'ubuntu', 'admin', 'postgres', 'www-data', 'nobody',
  'centos', 'debian', 'fedora', 'azureuser', 'opc', 'core', 'vagrant', 'docker',
  'str', 'string', 'int', 'bool', 'any', 'none', 'null', 'nil', 'true', 'false',
  'undefined', 'hi', 'hello', 'hey', 'yes', 'no', 'ok', 'okay', 'thanks',
  'continue', 'go', 'stop', 'help', 'test', 'y', 'n',
])

/** magpie publicHosts: hosts everyone's ssh and git go to. */
const PUBLIC_HOSTS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com',
  'localhost', 'host', 'hostname', 'server', 'remote', 'example', 'your-server',
  'str', 'string', 'none', 'null', 'true', 'false', 'undefined',
])

/** magpie userOK. */
export function userOK(v: string): boolean {
  const l = v.toLowerCase()
  return v.length >= 2 && !NOT_USERS.has(l) && !NOT_NAMES.has(l)
}

/** magpie hostOK: a host name, not an address, an example or a reserved word. */
export function hostOK(v: string): boolean {
  const l = v.toLowerCase().replace(/\.$/, '')
  if (l.length < 2 || PUBLIC_HOSTS.has(l) || l.startsWith('process.') || l.startsWith('os.') || l.startsWith('env.')) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(l)) return false
  for (const ex of ['example.com', 'example.org', 'example.net', '.example', '.test', '.invalid', '.localhost']) {
    const bare = ex.startsWith('.') ? ex.slice(1) : ex
    if (l === bare || l.endsWith(ex)) return false
  }
  return true
}

const RESOLVERS = new Set(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '149.112.112.112',
  '208.67.222.222', '208.67.220.220', '114.114.114.114', '223.5.5.5', '223.6.6.6',
  '119.29.29.29', '180.76.76.76'])

/** magpie publicIP, v4 part: not private / loopback / CGNAT / doc / reserved. */
export function publicIPv4(v: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some(x => x > 255)) return false
  if (RESOLVERS.has(v)) return false
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && o[2] === 100) return false
  if (a === 203 && b === 0 && o[2] === 113) return false
  if (a === 169 && b === 254) return false
  if (a >= 224) return false
  return true
}

/** magpie ipv4At: a public dotted quad, not a piece of a version. */
export function ipv4At(s: string, a: number, b: number): boolean {
  if (a > 0) {
    const c = s[a - 1]
    if (/[A-Za-z0-9._\-=~^]/.test(c)) return false
    if (c === '/' && a >= 2 && /[A-Za-z0-9._-]/.test(s[a - 2])) return false
  }
  if (b < s.length) {
    const c = s[b]
    if (/[A-Za-z0-9_-]/.test(c)) return false
    if (c === '.' && b + 1 < s.length && /[0-9]/.test(s[b + 1])) return false
  }
  const before = s.slice(Math.max(0, a - 16), a).replace(/[ \t:="']+$/, '').toLowerCase()
  for (const w of ['version', 'ver', 'release', 'build', 'rev', '版本']) {
    if (before.endsWith(w) && (before.length === w.length || !/[A-Za-z0-9_]/.test(before[before.length - w.length - 1]))) return false
  }
  return publicIPv4(s.slice(a, b))
}

/** magpie ipv6OK / publicIP, v6 part: global unicast only. */
export function ipv6OK(v: string): boolean {
  if ((v.match(/:/g) ?? []).length < 2) return false
  if (v.includes('.')) return false
  const l = v.toLowerCase()
  if (l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return false
  if (l.startsWith('2001:db8') || l.startsWith('64:ff9b') || l.startsWith('100::')) return false
  const first = parseInt(l.split(':')[0] || '0', 16)
  return (first & 0xe000) === 0x2000
}

/** magpie notBuckets: buckets docs and examples name. */
const NOT_BUCKETS = new Set([
  'bucket', 'my-bucket', 'mybucket', 'bucket-name', 'bucketname', 'my-bucket-name',
  'your-bucket', 'your-bucket-name', 'yourbucket', 'example-bucket', 'examplebucket',
  'amzn-s3-demo-bucket', 'doc-example-bucket', 's3', 'www', 'storage', 'container',
  'mycontainer', 'my-container', 'mystorageaccount', 'account',
  'upload', 'download', 'batch', 'b', 'v1', 'v2', 'api',
])

/** magpie bucketOK. */
export function bucketOK(v: string): boolean {
  const l = v.toLowerCase()
  return l.length >= 3 && !NOT_BUCKETS.has(l) && l.replace(/[0-9]/g, '') !== ''
}

const secretCh = "[A-Za-z0-9_\\-./+=~!@#%^&*]"
const secretNames = 'password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|priv[_-]?key|credential'

// shared fragments for the personal-data rules (magpie more.go)
const SEP = `["']?[ \\t]*(?:[:#=：][ \\t]*)?`
const MONTHS = `(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?`
const PATH_NAME = "[^\\s/\\\\:*?\"'<>|,;()\\[\\]{}`$%]{1,64}"
const HOST_RE = `[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\\.[A-Za-z0-9-]{1,63})*`
const UNIX_USER = `[a-z_][a-z0-9_.-]{0,31}`
const LINE_USER = `[A-Za-z0-9_][A-Za-z0-9._-]{0,31}`
const BUCKET_RE = `[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?`

export const RULES: readonly RuleDef[] = [
  // ---- secrets (cat '') ----
  { id: 'private-key', kind: 'PRIVATE_KEY', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'sk', kind: 'API_KEY', re: /sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/, ok: notASlug },
  { id: 'relay-sk', kind: 'API_KEY', re: /[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}/, ok: secretValue },
  { id: 'ark', kind: 'API_KEY', re: /ark-[A-Za-z0-9][A-Za-z0-9_-]{15,}/, ok: secretValue },
  { id: 'github', kind: 'API_KEY', re: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}/ },
  { id: 'google', kind: 'API_KEY', re: /AIza[0-9A-Za-z_-]{35}/ },
  { id: 'slack', kind: 'API_KEY', re: /xox[abposr]-[0-9A-Za-z-]{10,}/ },
  { id: 'live', kind: 'API_KEY', re: /(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
  { id: 'aws', kind: 'API_KEY', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  { id: 'misc', kind: 'API_KEY', re: /hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/ },
  { id: 'cloudflare', kind: 'API_KEY', re: /cf(?:ut|at|k|oat)_[A-Za-z0-9_-]{40,}|v1\.0-[A-Za-z0-9]{16,}-[A-Za-z0-9]{40,}/ },
  { id: 'cf-tunnel', kind: 'TOKEN', re: /eyJhIjoi[A-Za-z0-9+/_-]{40,}={0,2}/ },
  { id: 'jwt', kind: 'TOKEN', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'x-auth-key', kind: 'SECRET', group: true, re: new RegExp(`x-auth-(?:user-service-)?key["']?[ \\t]*[:=][ \\t]*["']?([A-Za-z0-9._-]{16,})`, 'i') },
  { id: 'url-password', kind: 'PASSWORD', group: true, re: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*:([^\s@/?#"'<>]{3,})@/ },
  { id: 'secret-name', kind: 'SECRET', group: true, re: new RegExp(`[A-Za-z0-9_.-]*(?:${secretNames})[A-Za-z0-9_.-]*["']?[ \\t]*[:=][ \\t]*["']?(${secretCh}{8,})`, 'i'), ok: secretValue },
  { id: 'env-upper', kind: 'SECRET', group: true, re: new RegExp(`(?:^|[^A-Za-z0-9_.-])[A-Z][A-Z0-9_.-]*_(?:KEY|PASS)["']?[ \\t]*[:=][ \\t]*["']?(${secretCh}{8,})`), ok: secretValue },
  { id: 'auth-header', kind: 'SECRET', group: true, re: /^[ \t]*(?:authorization|cookie)[ \t]*:[ \t]*(\S[^\r\n]{7,})/im, ok: headerValue },
  { id: 'plain-key', kind: 'SECRET', group: true, re: /(?:^|[^A-Za-z0-9_.-])key["'`]?[ \t]*[:=][ \t]*["'`]?([A-Za-z0-9_./+=~!@#%^&*-]{16,})/i, ok: secretValue },
  { id: 'cjk-password', kind: 'PASSWORD', group: true, re: /(?:密码|密碼|口令|PIN码|PIN碼|安全码|安全碼|パスワード|暗証番号|비밀번호|암호|비번)[ \t]*(?:[:：=][ \t]*|[为為是][ \t]*[:：]?[ \t]*)?(?:\\?["'“「])?([A-Za-z0-9_\-/+=~!@#%^&*]{3,63}[A-Za-z0-9_\-/+=~!@#%^&*])/ },
  { id: 'cjk-key', kind: 'SECRET', group: true, re: /(?:密钥|密鑰|秘钥|私钥|金钥|令牌|授权码|秘密鍵|トークン|シークレット|토큰|비밀키)[ \t]*(?:[:：=][ \t]*|[为為是][ \t]*[:：]?[ \t]*)?(?:\\?["'“「])?([A-Za-z0-9_\-/+=~!@#%^&*]{3,63}[A-Za-z0-9_\-/+=~!@#%^&*])/ },

  // ---- core personal (cat 'personal') ----
  { id: 'email', kind: 'EMAIL', cat: 'personal',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    // magpie realEmail: git@ is every git host's SSH user, no mailbox;
    // example/localhost/test/invalid hosts are documentation, not mail
    ok: (v) => {
      const at = v.lastIndexOf('@')
      if (v.slice(0, at).toLowerCase() === 'git') return false
      const host = v.slice(at + 1).toLowerCase()
      for (const fake of ['example.com', 'example.org', 'example.net', 'localhost', '.test', '.invalid', '.example']) {
        const bare = fake.startsWith('.') ? fake.slice(1) : fake
        if (host === bare || host.endsWith(fake)) return false
      }
      return true
    },
    // an email-shaped run right after "scheme://user:" is a URL password, not an email (magpie emailAt)
    at: (text, start) => !/:\/\/[^\s:@/?#"'<>]*:$/.test(text.slice(Math.max(0, start - 200), start)) },
  { id: 'id-card', kind: 'ID_CARD', cat: 'personal', re: /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/, ok: chineseID },
  { id: 'phone', kind: 'PHONE', cat: 'personal', re: /(?:\+?86[- ]?)?1[3-9]\d{9}/ },
  { id: 'bank-card', kind: 'BANK_CARD', cat: 'personal', re: /[3-6]\d{3}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?/, ok: luhn },

  // ---- extended personal categories (magpie more.go, cat id under kinds{}) ----
  // US SSN: 123-45-6789 as written, or nine digits after "SSN" / "social security"
  { id: 'ssn-dashed', kind: 'SSN', cat: 'ssn', re: /\d{3}-\d{2}-\d{4}/, ok: ssnOK },
  { id: 'ssn-named', kind: 'SSN', cat: 'ssn', group: true, ok: ssnOK,
    re: new RegExp(`(?:\\bssn\\b|\\bsocial[ \\t]+security(?:[ \\t]+(?:number|no\\.?|#))?)${SEP}(?:(?:is)[ \\t]+)?["']?(\\d{9}|\\d{3} \\d{2} \\d{4})`, 'i') },

  // passports after their name, in Latin and CJK scripts
  { id: 'passport', kind: 'PASSPORT', cat: 'passport', anyGroup: true, ok: passportOK,
    re: new RegExp(`(?:\\bpassport(?:[ \\t]*(?:no\\.?|number|num|#))?\\b|\\breisepass(?:nummer)?)${SEP}(?:(?:is|was)[ \\t]+)?["']?([A-Z0-9]{6,9})` +
      `|(?:护照(?:号码|号)?|護照(?:號碼|号码|番号)?|パスポート(?:番号)?)[ \\t]*(?:[:：=][ \\t]*)?(?:是[ \\t]*|は[ \\t]*)?["']?([A-Z0-9]{6,9})`, 'i') },

  // IBAN, one word or in groups of four, by checksum
  { id: 'iban', kind: 'IBAN', cat: 'iban', fix: ibanAt,
    re: /[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)/ },

  // a date after the words that say it is a birthday; a date alone is not
  { id: 'birthday', kind: 'BIRTHDAY', cat: 'birthday', group: true, ok: dateOK,
    re: new RegExp(`(?:(?:\\bdate[ \\t]+of[ \\t]+birth|\\bbirth[ \\t_-]?date\\b|\\bbirthday\\b|\\bdob\\b|\\bd\\.o\\.b\\.?|\\bborn(?:[ \\t]+on)?\\b|\\bgeburtsdatum\\b|\\bgeboren(?:[ \\t]+am)?)|生日|出生日期|出生年月日|出生于|出生於|出生|誕生日|生年月日)` +
      `${SEP}(?:(?:is|was)[ \\t]+|是[ \\t]*|为[ \\t]*|為[ \\t]*|は[ \\t]*)?["']?` +
      `(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{4}[ \\t]*年[ \\t]*\\d{1,2}[ \\t]*月[ \\t]*\\d{1,2}[ \\t]*日?|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}` +
      `|${MONTHS}[ \\t]+\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?[ \\t]+${MONTHS},?[ \\t]+\\d{4})`, 'i') },

  // MAC address, aa:bb:cc:dd:ee:ff or aa-bb-cc-dd-ee-ff
  { id: 'mac', kind: 'MAC', cat: 'mac', re: /[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}/, ok: macOK },

  // serial number after S/N, Serial or 序列号
  { id: 'serial', kind: 'SERIAL', cat: 'serial', anyGroup: true, ok: serialOK,
    re: new RegExp(`(?:\\bserial[ \\t_-]?(?:number|num|no\\.?|#)?\\b|\\bs/n\\b|\\bsn\\b)(?:[ \\t]*\\([^)\\n]{1,20}\\))?["']?[ \\t]*[:#=：][ \\t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})` +
      `|(?:序列号|序列號|シリアル番号|seriennummer)[ \\t]*[:：=]?[ \\t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})`, 'i') },

  // user name in a home folder: /Users/<name>, /home/<name>, C:\Users\<name>
  { id: 'home-unix', kind: 'USERNAME', cat: 'home', group: true, fix: (s, a, b) => homeAt(s, a, b),
    re: new RegExp(`(?:^|[^A-Za-z0-9_.~/\\\\-])(?:file://)?(?:/mnt/[a-z])?/(?:Users|home)/(${PATH_NAME})`) },
  { id: 'home-windows', kind: 'USERNAME', cat: 'home', anyGroup: true, fix: (s, a, b) => homeAt(s, a, b),
    re: new RegExp(`(?:^|[^A-Za-z0-9])[A-Za-z]:(?:\\\\{1,4}|/)(?:users|documents and settings)(?:\\\\{1,4}|/)` +
      `(?:([A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)+)(?:\\\\|/)|(${PATH_NAME}))`, 'i') },

  // user@host as a shell prompt / ssh target has it; masked as one span
  { id: 'userhost-shell', kind: 'USERHOST', cat: 'userhost',
    groups: ['USERNAME', 'HOSTNAME'], groupOK: [userOK, hostOK],
    re: new RegExp(`(?:^|[^A-Za-z0-9._%+-])(${UNIX_USER})@(${HOST_RE})(?::[~/]|:[ \\t]*$|[ \\t]+[~/]|[ \\t]*[$%#>][ \\t]|[ \\t]*[$%#>]$)`, 'm') },
  // ssh/scp/rsync target: find user@host first, then check an ssh verb
  // stands within 80 chars before it (magpie's lazy prefix can't be
  // re-entered after a context rejection, so the verb check moves to `at`)
  { id: 'userhost-ssh', kind: 'USERHOST', cat: 'userhost',
    groups: ['USERNAME', 'HOSTNAME'], groupOK: [userOK, hostOK],
    re: new RegExp(`(${UNIX_USER})@(${HOST_RE})`),
    at: (s, a, b) => {
      // a label after the group still belongs to a longer host — exclude
      // "…user@host@dom" (HOST_RE can't see the second @)
      const rest = s.slice(b)
      if (/^[A-Za-z0-9-]*@/.test(rest)) return false
      // an ssh verb in the 80 chars before, separated from the login by
      // whitespace or a quote
      const before = s.slice(Math.max(0, a - 90), a)
      if (!/\b(?:ssh|scp|sftp|rsync|mosh|ssh-copy-id)\b[^\n]{0,80}?[ \t"']$/.test(before)) return false
      return true
    } },

  // hostname: x / HostName x lines (ssh config)
  { id: 'hostname-line', kind: 'HOSTNAME', cat: 'userhost', anyGroup: true, ok: hostOK,
    re: new RegExp(`^[ \\t]*["']?(?:(?:host[ \\t_-]?name|computer[ \\t_-]?name|machine[ \\t_-]?name|device[ \\t_-]?name)|主机名|主機名|計算機名|コンピュータ名|コンピューター名)["']?` +
      `[ \\t]*[:=：][ \\t]*(?:["'](${HOST_RE})["'][ \\t]*[,;]?|(${HOST_RE}))[ \\t]*$|^[ \\t]+HostName[ \\t]+(${HOST_RE})[ \\t]*$`, 'im') },

  // User: x / USER=x lines (ssh config's User, indented)
  { id: 'username-line', kind: 'USERNAME', cat: 'userhost', anyGroup: true, ok: userOK,
    re: new RegExp(`^[ \\t]*["']?(?:(?:user[ \\t_-]?name|login[ \\t_-]?name|user|login|logname)|用户名|用戶名|ユーザー名)["']?` +
      `[ \\t]*[:=：][ \\t]*(?:["'](${LINE_USER})["'][ \\t]*[,;]?|(${LINE_USER}))[ \\t]*$|^[ \\t]+User[ \\t]+(${LINE_USER})[ \\t]*$`, 'im') },

  // public IPs: not private / loopback / documentation / resolver / version
  { id: 'ipv4', kind: 'IP', cat: 'ip', at: ipv4At,
    re: /(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}/ },
  { id: 'ipv6', kind: 'IP', cat: 'ip', ok: ipv6OK,
    re: /[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7}/ },

  // cloud buckets: s3://b, gs://b, b.s3.amazonaws.com, s3.amazonaws.com/b …
  { id: 'bucket-uri', kind: 'BUCKET', cat: 'bucket', group: true, ok: bucketOK,
    re: new RegExp(`(?:\\b(?:s3a?|s3n|gs|oss|cosn?|obs|r2|ks3|bos|tos|az|azure|wasbs?|abfss?)://)(${BUCKET_RE})`, 'i') },
  { id: 'bucket-vhost', kind: 'BUCKET', cat: 'bucket', group: true, ok: bucketOK,
    re: /(?:^|[^A-Za-z0-9.-])([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)\.(?:s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?|s3-accelerate\.amazonaws\.com|storage\.googleapis\.com|oss-[a-z0-9-]+\.aliyuncs\.com|cos\.[a-z0-9-]+\.myqcloud\.com|obs\.[a-z0-9-]+\.myhuaweicloud\.com|r2\.cloudflarestorage\.com|(?:blob|dfs)\.core\.windows\.net|[a-z0-9-]+\.digitaloceanspaces\.com|tos-[a-z0-9-]+\.volces\.com)/ },
  { id: 'bucket-path', kind: 'BUCKET', cat: 'bucket', group: true, ok: bucketOK,
    re: new RegExp(`(?:^|[^A-Za-z0-9.-])(?:s3(?:[.-](?:dualstack\\.)?[a-z0-9-]+)?\\.amazonaws\\.com(?:\\.cn)?|storage\\.googleapis\\.com|storage\\.cloud\\.google\\.com|[a-z0-9]{3,24}\\.blob\\.core\\.windows\\.net|oss-[a-z0-9-]+\\.aliyuncs\\.com|[a-z0-9-]+\\.digitaloceanspaces\\.com)/(${BUCKET_RE})`) },
]
