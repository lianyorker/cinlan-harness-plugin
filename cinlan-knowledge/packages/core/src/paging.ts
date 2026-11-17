import type { Page } from "@cinlan/knowledge-sdk";
import { optInt, optString, Validator } from "./validate.js";

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 100;

export interface PageRequest {
  limit: number;
  offset: number;
}

/**
 * limit 默认 20、上限 100；cursor 是上一页的 offset（十进制字符串）。
 * 游标用 offset 而不是 id：资产按 updated_at 排序时会移动，翻页期间允许重复，不允许丢页。
 */
export function readPage(v: Validator, body: Record<string, unknown>): PageRequest {
  const limit = optInt(v, body, "limit", 1, PAGE_MAX) ?? PAGE_DEFAULT;
  const cursor = optString(v, body, "cursor");
  let offset = 0;
  if (cursor !== undefined && cursor !== "") {
    if (!/^\d+$/.test(cursor)) {
      v.issue("cursor is malformed");
    } else {
      offset = Number(cursor);
    }
  }
  return { limit, offset };
}

/**
 * 多取一行判断是否到底；next_cursor 为空串表示没有下一页。
 * rows 必须已截断到 ≤ limit + 1。
 */
export function makePage<T>(rows: T[], page: PageRequest): Page<T> {
  const more = rows.length > page.limit;
  return {
    items: more ? rows.slice(0, page.limit) : rows,
    next_cursor: more ? String(page.offset + page.limit) : "",
  };
}
