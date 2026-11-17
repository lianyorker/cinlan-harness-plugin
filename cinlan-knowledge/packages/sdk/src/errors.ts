/**
 * 错误枚举是稳定契约：hub 与所有客户端共用这一份。
 * 只增不改；人读说明放 data.detail，不进 message。
 */
export const ERROR_HTTP_STATUS = {
  INVALID_ARGUMENT: 400,
  REASON_REQUIRED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNKNOWN_ACTION: 404,
  METHOD_NOT_ALLOWED: 405,
  ALREADY_EXISTS: 409,
  VERSION_CONFLICT: 409,
  REVIEW_NOT_PENDING: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as ErrorCode[];

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_HTTP_STATUS, value);
}
