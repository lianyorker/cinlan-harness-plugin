import { ERROR_HTTP_STATUS, type ErrorCode } from "./errors.js";

/**
 * 统一信封。code = 0 表示成功；出错时 HTTP 状态 = code，
 * message 是大写枚举，客户端只对它做分支。
 */
export interface Envelope<T = unknown> {
  code: number;
  message: "OK" | ErrorCode;
  request_id: string;
  data: T;
}

export function ok<T>(data: T, request_id: string): Envelope<T> {
  return { code: 0, message: "OK", request_id, data };
}

export function fail(
  code: ErrorCode,
  request_id: string,
  data: Record<string, unknown> = {},
): Envelope<Record<string, unknown>> {
  return { code: ERROR_HTTP_STATUS[code], message: code, request_id, data };
}

export function httpStatusOf(env: Envelope): number {
  return env.code === 0 ? 200 : env.code;
}
