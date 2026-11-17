/**
 * 按 key 限流（api.md §2 `RATE_LIMITED`）：固定窗口计数，状态只在本进程内存里，重启即清零。
 * 桶只给认证通过的 key 建，条数不会超过库里的 key 数，所以不另做清理。
 */

export interface RateLimit {
  windowSeconds: number;
  maxRequests: number;
}

/** 配置里没写 `limits.rateLimit` 时用这一份 */
export const DEFAULT_RATE_LIMIT: RateLimit = { windowSeconds: 60, maxRequests: 600 };

export interface RateLimiter {
  /** 记一次请求。额度用完时回 `retry_after`：离窗口结束还有几秒（向上取整，至少 1）。 */
  hit(key_id: string): { ok: true } | { ok: false; retry_after: number };
}

export function createRateLimiter(limit: RateLimit): RateLimiter {
  const windowMs = limit.windowSeconds * 1000;
  const buckets = new Map<string, { started: number; count: number }>();
  return {
    hit(key_id) {
      // 单调时钟：系统时间被校准也不会把窗口拉长或缩短
      const now = performance.now();
      const bucket = buckets.get(key_id);
      if (!bucket || now - bucket.started >= windowMs) {
        buckets.set(key_id, { started: now, count: 1 });
        return { ok: true };
      }
      if (bucket.count < limit.maxRequests) {
        bucket.count += 1;
        return { ok: true };
      }
      // 被拒的请求不计数、不续窗口
      return { ok: false, retry_after: Math.max(1, Math.ceil((bucket.started + windowMs - now) / 1000)) };
    },
  };
}
