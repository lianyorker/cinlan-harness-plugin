import { invalid } from "./errors.js";
import { isSlug } from "./ids.js";

/**
 * 校验全部问题一次收集，最后统一抛 INVALID_ARGUMENT（data.issues 列出全部）。
 * 请求越小越早返回，但同一层的字段错误不早退——调用方一次就能修完。
 */
export class Validator {
  readonly issues: string[] = [];

  issue(message: string): void {
    this.issues.push(message);
  }

  done(): void {
    if (this.issues.length > 0) throw invalid("invalid argument", this.issues);
  }
}

export function asObject(body: Record<string, unknown>): Record<string, unknown> {
  return body ?? {};
}

export function reqString(v: Validator, obj: object, field: string, max?: number): string {
  const raw = (obj as Record<string, unknown>)[field];
  if (typeof raw !== "string" || raw === "") {
    v.issue(`${field} is required`);
    return "";
  }
  if (max !== undefined && raw.length > max) v.issue(`${field} exceeds ${max} chars`);
  return raw;
}

export function optString(v: Validator, obj: object, field: string, max?: number): string | undefined {
  const raw = (obj as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    v.issue(`${field} must be a string`);
    return undefined;
  }
  if (max !== undefined && raw.length > max) v.issue(`${field} exceeds ${max} chars`);
  return raw;
}

export function optBool(v: Validator, obj: object, field: string): boolean | undefined {
  const raw = (obj as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    v.issue(`${field} must be a boolean`);
    return undefined;
  }
  return raw;
}

export function reqSlug(v: Validator, obj: object, field: string): string {
  const s = reqString(v, obj, field);
  if (s !== "" && !isSlug(s)) v.issue(`${field} must match ${/^[a-z0-9][a-z0-9-]{0,63}$/}`);
  return s;
}

export function optSlug(v: Validator, obj: object, field: string): string | undefined {
  const s = optString(v, obj, field);
  if (s !== undefined && !isSlug(s)) v.issue(`${field} must match ${/^[a-z0-9][a-z0-9-]{0,63}$/}`);
  return s;
}

export function optNumber(v: Validator, obj: object, field: string): number | undefined {
  const raw = (obj as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    v.issue(`${field} must be a number`);
    return undefined;
  }
  return raw;
}

export function optInt(v: Validator, obj: object, field: string, min?: number, max?: number): number | undefined {
  const n = optNumber(v, obj, field);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) {
    v.issue(`${field} must be an integer`);
    return undefined;
  }
  if (min !== undefined && n < min) v.issue(`${field} must be >= ${min}`);
  if (max !== undefined && n > max) v.issue(`${field} must be <= ${max}`);
  return n;
}

export function optOneOf<T extends string>(v: Validator, obj: object, field: string, allowed: readonly T[]): T | undefined {
  const raw = (obj as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    v.issue(`${field} must be one of ${allowed.join(" | ")}`);
    return undefined;
  }
  return raw as T;
}

export function reqOneOf<T extends string>(v: Validator, obj: object, field: string, allowed: readonly T[]): T {
  const value = optOneOf(v, obj, field, allowed);
  if (value === undefined) v.issue(`${field} is required`);
  return value as T;
}

/** tags：≤16 个，每个 ≤32 字符，去重后排序（入库形状稳定，content_hash 才稳定）。 */
export function optTags(v: Validator, obj: object, field = "tags"): string[] | undefined {
  const raw = (obj as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    v.issue(`${field} must be an array of strings`);
    return undefined;
  }
  if (raw.length > 16) v.issue(`${field} holds at most 16 items`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "") {
      v.issue(`${field} items must be non-empty strings`);
      continue;
    }
    if (item.length > 32) v.issue(`${field} item exceeds 32 chars: ${item.slice(0, 16)}…`);
    out.push(item);
  }
  return [...new Set(out)].sort();
}

/** id 形状：<前缀>_<24hex>。用于入参快速拒绝，不承担存在性判断。 */
const ID_RE = /^[a-z]+_[0-9a-f]{24}$/;
export function isId(value: string): boolean {
  return ID_RE.test(value);
}

/** ISO-8601 UTC；null 表示显式清空。 */
export function optIso(v: Validator, obj: object, field: string): string | null | undefined {
  const raw = (obj as Record<string, unknown>)[field];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    v.issue(`${field} must be an ISO-8601 timestamp`);
    return undefined;
  }
  return new Date(raw).toISOString();
}
