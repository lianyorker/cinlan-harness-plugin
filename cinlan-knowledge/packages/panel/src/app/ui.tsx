import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Loading, Tag, Tooltip } from "tdesign-react";
import { CheckIcon, CloseIcon, CopyIcon, RefreshIcon } from "tdesign-icons-react";
import type {
  AclPermission,
  AgentStatus,
  AssetStatus,
  AssetType,
  InjectionMode,
  ReviewKind,
  ReviewStatus,
  SkipReason,
  Visibility,
  ImportStatus,
} from "@cinlan/knowledge-sdk";
import { ApiError } from "../lib/api.js";
import { describeErrorCode } from "../lib/errors.js";
import {
  agentStatusLabel,
  assetStatusLabel,
  assetTypeLabel,
  importStatusLabel,
  injectionModeLabel,
  reviewKindLabel,
  reviewStatusLabel,
  skipReasonLabel,
  visibilityLabel,
} from "../lib/format.js";

/* ---------- 数据加载 ---------- */

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload(): void;
}

/** 页面级加载：组件卸载时中止；AbortError 不算错误。 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadRef.current(controller.signal)
      .then((value) => {
        if (!alive) return;
        setData(value);
        setLoading(false);
      })
      .catch((cause) => {
        if (!alive || (cause instanceof Error && cause.name === "AbortError")) return;
        setError(toApiError(cause));
        setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError({
    code: "BAD_RESPONSE",
    status: 0,
    requestId: "",
    detail: cause instanceof Error ? cause.message : String(cause),
    data: {},
    retryAfter: null,
  });
}

/* ---------- 页面骨架 ---------- */

export function PageHeader(props: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ck-page-head">
      <div>
        <h1 className="ck-page-title">{props.title}</h1>
        {props.description ? <p className="ck-page-desc">{props.description}</p> : null}
      </div>
      {props.actions ? <div className="ck-page-actions">{props.actions}</div> : null}
    </div>
  );
}

export function LoadingState(props: { text?: string }) {
  return (
    <div className="ck-state" role="status">
      <Loading loading size="small" />
      <span className="ck-state-text">{props.text ?? "加载中…"}</span>
    </div>
  );
}

/** 错误态：错误枚举 + 人读文案 + request_id + 重试。429 时按 retryAfter 倒计时再允许重试。 */
export function ErrorBlock(props: { error: ApiError; onRetry?: () => void }) {
  const { error } = props;
  const [left, setLeft] = useState(error.retryAfter ?? 0);

  useEffect(() => {
    setLeft(error.retryAfter ?? 0);
  }, [error]);

  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  return (
    <div className="ck-error" role="alert">
      <div className="ck-error-head">
        <strong>{describeErrorCode(error.code)}</strong>
        <Tag variant="light" theme="danger">
          {error.code}
        </Tag>
      </div>
      {error.detail ? <p className="ck-error-detail">{error.detail}</p> : null}
      <p className="ck-error-meta">
        {error.requestId ? `request_id ${error.requestId} · ` : ""}
        {`HTTP ${error.status}`}
      </p>
      {props.onRetry ? (
        <Button
          variant="outline"
          icon={<RefreshIcon />}
          disabled={left > 0}
          onClick={props.onRetry}
        >
          {left > 0 ? `${left} 秒后可重试` : "重试"}
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState(props: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="ck-empty">
      <p className="ck-empty-title">{props.title}</p>
      {props.hint ? <p className="ck-empty-hint">{props.hint}</p> : null}
      {props.action ? <div className="ck-empty-action">{props.action}</div> : null}
    </div>
  );
}

/* ---------- 标签 ---------- */

type TagTheme = "default" | "primary" | "success" | "warning" | "danger";

const ASSET_STATUS_THEME: Record<AssetStatus, TagTheme> = {
  draft: "default",
  active: "success",
  deprecated: "warning",
  archived: "default",
};

export function AssetStatusTag({ status }: { status: AssetStatus }) {
  return (
    <Tag variant="light" theme={ASSET_STATUS_THEME[status]}>
      {assetStatusLabel(status)}
    </Tag>
  );
}

export function AssetTypeTag({ type }: { type: AssetType }) {
  return <Tag variant="outline">{assetTypeLabel(type)}</Tag>;
}

export function VisibilityTag({ visibility }: { visibility: Visibility }) {
  return <Tag variant="light">{visibilityLabel(visibility)}</Tag>;
}

const REVIEW_STATUS_THEME: Record<ReviewStatus, TagTheme> = {
  pending: "primary",
  approved: "success",
  rejected: "danger",
  withdrawn: "default",
  stale: "warning",
};

export function ReviewStatusTag({ status }: { status: ReviewStatus }) {
  return (
    <Tag variant="light" theme={REVIEW_STATUS_THEME[status]}>
      {reviewStatusLabel(status)}
    </Tag>
  );
}

export function ReviewKindTag({ kind }: { kind: ReviewKind }) {
  return <Tag variant="outline">{reviewKindLabel(kind)}</Tag>;
}

export function AgentStatusTag({ status }: { status: AgentStatus }) {
  return (
    <Tag variant="light" theme={status === "active" ? "success" : "default"}>
      {agentStatusLabel(status)}
    </Tag>
  );
}

export function InjectionModeTag({ mode }: { mode: InjectionMode }) {
  return <Tag variant="light">{injectionModeLabel(mode)}</Tag>;
}

export function SkipReasonTag({ reason }: { reason: SkipReason }) {
  return (
    <Tag variant="light" theme="warning">
      {skipReasonLabel(reason)}
    </Tag>
  );
}

export function PermissionTag({ permission }: { permission: AclPermission }) {
  return <Tag variant="outline">{permission === "manage" ? "管理" : "读取"}</Tag>;
}

export function ImportStatusTag({ status }: { status: ImportStatus }) {
  const theme: TagTheme = status === "created" ? "success" : status === "conflict" ? "warning" : "default";
  return (
    <Tag variant="light" theme={theme}>
      {importStatusLabel(status)}
    </Tag>
  );
}

/** 可见但无权限的按钮：禁用 + Tooltip 说明原因（panel-design.md §6.5）。 */
export function LockedAction(props: { label: string; reason: string; onClick?: () => void }) {
  return (
    <Tooltip content={props.reason}>
      <span>
        <Button variant="outline" disabled>
          {props.label}
        </Button>
      </span>
    </Tooltip>
  );
}

/* ---------- 复制 ---------- */

export function CopyButton(props: { text: string; label?: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setState("done");
    } catch {
      setState("fail");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, [props.text]);

  return (
    <Button
      size="small"
      variant="text"
      disabled={props.disabled}
      icon={state === "done" ? <CheckIcon /> : state === "fail" ? <CloseIcon /> : <CopyIcon />}
      onClick={() => void copy()}
    >
      {state === "done" ? "已复制" : state === "fail" ? "复制失败" : (props.label ?? "复制")}
    </Button>
  );
}

/** 一次性明文 key：只在该响应里出现一次，关闭后不可再查看。 */
export function KeyReveal(props: { open: boolean; title?: string; text: string; onClose(): void }) {
  return (
    <Dialog
      visible={props.open}
      header={props.title ?? "新建的 key 只显示这一次"}
      confirmBtn={{ content: "我已保存", theme: "primary" }}
      cancelBtn={null}
      closeOnOverlayClick={false}
      onConfirm={props.onClose}
      onClose={props.onClose}
      width={560}
    >
      <p className="ck-note">请立即复制并安全转交；关闭后 hub 只保留前缀，无法再次查看明文。</p>
      <pre className="ck-code ck-code-key">{props.text}</pre>
      <CopyButton text={props.text} label="复制 key" />
    </Dialog>
  );
}

/* ---------- 正文 ---------- */

/** 只读 Markdown / 纯文本：不引渲染库，保留换行与空白（panel-design.md §6.4）。 */
export function ReadonlyContent(props: { text: string }) {
  return <pre className="ck-content">{props.text}</pre>;
}

export function KV(props: { label: string; children: ReactNode }) {
  return (
    <div className="ck-kv">
      <span className="ck-kv-label">{props.label}</span>
      <span className="ck-kv-value">{props.children}</span>
    </div>
  );
}
