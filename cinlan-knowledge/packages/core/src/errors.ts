import type { ErrorCode } from "@cinlan/knowledge-sdk";

/**
 * 业务错误：携带错误枚举与可放进信封 data 的细节。
 * hub 只把它翻译成 HTTP 状态 + 信封；未捕获的其它异常一律 INTERNAL。
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly data: Record<string, unknown>;

  constructor(code: ErrorCode, detail: string, data: Record<string, unknown> = {}) {
    super(detail);
    this.name = "DomainError";
    this.code = code;
    this.detail = detail;
    this.data = data;
  }
}

export function invalid(detail: string, issues: string[] = []): DomainError {
  return new DomainError("INVALID_ARGUMENT", detail, { issues });
}

export function notFound(detail = "not found"): DomainError {
  return new DomainError("NOT_FOUND", detail);
}

export function forbidden(detail = "forbidden"): DomainError {
  return new DomainError("FORBIDDEN", detail);
}

export function alreadyExists(detail: string): DomainError {
  return new DomainError("ALREADY_EXISTS", detail);
}

export function versionConflict(current_version: number): DomainError {
  return new DomainError("VERSION_CONFLICT", "base_version is not current", { current_version });
}

export function reviewNotPending(): DomainError {
  return new DomainError("REVIEW_NOT_PENDING", "review is no longer pending");
}

export function reasonRequired(): DomainError {
  return new DomainError("REASON_REQUIRED", "reject requires a reason");
}

export function payloadTooLarge(detail: string): DomainError {
  return new DomainError("PAYLOAD_TOO_LARGE", detail);
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
