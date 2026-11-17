import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** 各类 id：<前缀>_<24hex>。id 永不取自标题或文件名。 */
export function newId(prefix: "usr" | "key" | "team" | "agt" | "ast" | "rev"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** User Key：ck_<8 hex 前缀>_<32 hex 随机>。库里只存 prefix 与 digest。 */
export interface GeneratedKey {
  /** 明文，只出现一次 */
  key: string;
  prefix: string;
  digest: string;
}

export function generateUserKey(): GeneratedKey {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(16).toString("hex");
  const key = `ck_${prefix}_${secret}`;
  return { key, prefix, digest: sha256Hex(key) };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 定长比较，防时序侧信道；长度不同直接 false。 */
export function digestEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/** 解析 Bearer key 的前缀；形状不对返回 null，不做任何查询。 */
export function parseKeyPrefix(key: string): string | null {
  const m = /^ck_([0-9a-f]{8})_[0-9a-f]{32}$/.exec(key);
  return m ? m[1]! : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 稳定序列化：对象键排序、递归；用于 content_hash。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
