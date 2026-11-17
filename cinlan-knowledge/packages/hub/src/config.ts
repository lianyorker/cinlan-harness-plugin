import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RateLimit } from "./ratelimit.js";

/** install.md §1 的配置形状。校验失败一次性列出全部问题，不猜默认值。 */
export interface HubConfig {
  dataDir: string;
  listen: { host: string; port: number; allowedOrigins: string[] };
  limits: {
    maxBodyBytes: number;
    maxContentBytes: number;
    maxFileBytes: number;
    /** 按 key 限流的额度；不写则用 ratelimit.ts 的 DEFAULT_RATE_LIMIT */
    rateLimit?: RateLimit;
  };
  log: { level: "debug" | "info" | "warn" | "error" };
  /** P3（O-9）：向量检索（sqlite-vec）。缺省 = 不启用（纯 FTS，历史行为）。
   *  dims 是 vec0 索引的固定维度，须与回填模型一致；换不同维度的模型需重建索引全量重算。 */
  embedding?: { dims: number };
  /** P5（optimization-analysis §1.4）：自动备份。interval 格式 `every: 24h`（小时为单位）；
   *  不写则不自动备份（历史行为）。备份落 `<dataDir>/backups/`。 */
  backup?: { every: string };
}

export interface ConfigLoadResult {
  config: HubConfig | null;
  problems: string[];
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function loadConfig(file: string): ConfigLoadResult {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { config: null, problems: [`cannot read config ${file}: ${(err as Error).message}`] };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: null, problems: ["config must be a JSON object"] };
  }
  const src = raw as Record<string, unknown>;

  const dataDir = src.dataDir;
  if (typeof dataDir !== "string" || dataDir.trim() === "") {
    problems.push("dataDir: required non-empty string");
  }

  const listen = (src.listen ?? {}) as Record<string, unknown>;
  const host = typeof listen.host === "string" && listen.host !== "" ? listen.host : "127.0.0.1";
  const port = typeof listen.port === "number" && Number.isInteger(listen.port) && listen.port > 0 && listen.port < 65536 ? listen.port : 8424;
  if (listen.port !== undefined && port !== listen.port) problems.push("listen.port: integer 1..65535");
  const allowedOrigins = listen.allowedOrigins === undefined ? [] : listen.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((o) => typeof o !== "string")) {
    problems.push("listen.allowedOrigins: string[]");
  }

  const limits = (src.limits ?? {}) as Record<string, unknown>;
  const maxBodyBytes = typeof limits.maxBodyBytes === "number" ? limits.maxBodyBytes : 26214400;
  if (typeof limits.maxBodyBytes !== "undefined" && (typeof limits.maxBodyBytes !== "number" || limits.maxBodyBytes <= 0)) {
    problems.push("limits.maxBodyBytes: positive number");
  }
  const maxContentBytes = typeof limits.maxContentBytes === "number" ? limits.maxContentBytes : 262144;
  const maxFileBytes = typeof limits.maxFileBytes === "number" ? limits.maxFileBytes : 5242880;
  let rateLimit: RateLimit | undefined;
  if (limits.rateLimit !== undefined) {
    const given = limits.rateLimit as Record<string, unknown> | null;
    if (given === null || typeof given !== "object" || Array.isArray(given)) {
      problems.push("limits.rateLimit: object { windowSeconds, maxRequests }");
    } else {
      const positive = (field: "windowSeconds" | "maxRequests"): number => {
        const value = given[field];
        if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
        problems.push(`limits.rateLimit.${field}: positive integer`);
        return 0;
      };
      rateLimit = { windowSeconds: positive("windowSeconds"), maxRequests: positive("maxRequests") };
    }
  }

  const log = (src.log ?? {}) as Record<string, unknown>;
  const level = typeof log.level === "string" ? log.level : "info";
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    problems.push(`log.level: one of ${LOG_LEVELS.join(" | ")}`);
  }

  let embedding: { dims: number } | undefined;
  if (src.embedding !== undefined) {
    const given = src.embedding as Record<string, unknown> | null;
    if (given === null || typeof given !== "object" || Array.isArray(given)) {
      problems.push("embedding: object { dims }");
    } else {
      const dims = given.dims;
      if (typeof dims !== "number" || !Number.isInteger(dims) || dims < 1 || dims > 4096) {
        problems.push("embedding.dims: integer 1..4096");
      } else {
        embedding = { dims };
      }
    }
  }

  let backup: { every: string } | undefined;
  if (src.backup !== undefined) {
    const given = src.backup as Record<string, unknown> | null;
    if (given === null || typeof given !== "object" || Array.isArray(given)) {
      problems.push("backup: object { every }");
    } else {
      const every = given.every;
      // "24h" / "168h"（小时）；不接受其他单位
      if (typeof every !== "string" || !/^\d+h$/.test(every)) {
        problems.push("backup.every: \"Nh\" format (e.g. \"24h\")");
      } else {
        const hours = Number(every.slice(0, -1));
        if (hours < 1 || hours > 8760) problems.push("backup.every: 1..8760 hours");
        else backup = { every };
      }
    }
  }

  if (problems.length > 0) return { config: null, problems };

  return {
    config: {
      dataDir: isAbsolute(dataDir as string) ? (dataDir as string) : resolve(dataDir as string),
      listen: { host, port, allowedOrigins: allowedOrigins as string[] },
      limits: { maxBodyBytes, maxContentBytes, maxFileBytes, ...(rateLimit ? { rateLimit } : {}) },
      log: { level: level as HubConfig["log"]["level"] },
      ...(embedding ? { embedding } : {}),
      ...(backup ? { backup } : {}),
    },
    problems: [],
  };
}
