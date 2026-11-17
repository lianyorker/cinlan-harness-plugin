import { useState } from "react";
import { Button, Drawer, Select, Table, Textarea, MessagePlugin } from "tdesign-react";
import type { Review, ReviewKind, ReviewStatus } from "@cinlan/knowledge-sdk";
import { useApp } from "../app/context.js";
import {
  EmptyState,
  ErrorBlock,
  KV,
  LoadingState,
  PageHeader,
  ReadonlyContent,
  ReviewKindTag,
  ReviewStatusTag,
  toApiError,
  useAsync,
} from "../app/ui.js";
import { formatTime } from "../lib/format.js";
import { lineDiff } from "../lib/diff.js";
import { canManageTeam } from "../lib/roles.js";
import { ApiError } from "../lib/api.js";

const STATUS_OPTIONS: { label: string; value: ReviewStatus }[] = [
  { label: "待审", value: "pending" },
  { label: "已通过", value: "approved" },
  { label: "已驳回", value: "rejected" },
  { label: "已撤回", value: "withdrawn" },
  { label: "已失效", value: "stale" },
];

const KIND_OPTIONS: { label: string; value: ReviewKind }[] = [
  { label: "共享", value: "share" },
  { label: "修改", value: "update" },
  { label: "下线", value: "retire" },
];

/** 审批队列（panel-design.md §4.2）：团队维度的待办；mine 只看自己发起的。 */
export function ReviewsPage() {
  const app = useApp();
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [kind, setKind] = useState<ReviewKind | undefined>();
  const [mine, setMine] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const state = useAsync(
    (signal) =>
      app.call(
        "review/list",
        {
          limit: 20,
          team: app.currentTeam ?? undefined,
          mine: mine || undefined,
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
        },
        { signal },
      ),
    [app.currentTeam, status, kind, mine, version],
  );

  const rows = state.data?.items ?? [];
  const changed = () => setVersion((v) => v + 1);

  return (
    <>
      <PageHeader
        title="审批"
        description="团队资产共享、修改、下线都要过审。驳回必须填写理由。"
        actions={
          <Button variant="outline" onClick={() => state.reload()}>
            刷新
          </Button>
        }
      />

      <div className="ck-filters">
        <Select
          value={status}
          options={STATUS_OPTIONS}
          onChange={(value) => setStatus(value as ReviewStatus)}
          style={{ width: 140 }}
        />
        <Select
          value={kind}
          options={KIND_OPTIONS}
          placeholder="类型"
          clearable
          onChange={(value) => setKind(value as ReviewKind | undefined)}
          style={{ width: 140 }}
        />
        <label className="ck-check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          <span>只看我发起的</span>
        </label>
      </div>

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && rows.length === 0 ? (
        <EmptyState
          title={mine ? "你没有待处理的申请" : "当前没有待办的审批"}
          hint={status === "pending" ? "团队共享或修改提交后会出现在这里。" : "换个状态筛选看看。"}
        />
      ) : null}

      {rows.length > 0 ? (
        <section className="ck-panel">
        <Table
          rowKey="id"
          data={rows}
          hover
          columns={[
            { colKey: "id", title: "审批 id", width: 180, ellipsis: true },
            { colKey: "kind", title: "类型", width: 90, cell: ({ row }) => <ReviewKindTag kind={row.kind} /> },
            {
              colKey: "status",
              title: "状态",
              width: 100,
              cell: ({ row }) => <ReviewStatusTag status={row.status} />,
            },
            { colKey: "asset_id", title: "资产 id", width: 180, ellipsis: true },
            { colKey: "note", title: "说明", ellipsis: true, cell: ({ row }) => row.note || <span className="ck-muted">—</span> },
            { colKey: "created_at", title: "发起时间", width: 150, cell: ({ row }) => formatTime(row.created_at) },
          ]}
          onRowClick={({ row }) => setOpenId(row.id)}
        />
        </section>
      ) : null}

      <ReviewDrawer
        reviewId={openId}
        onClose={() => setOpenId(null)}
        onDone={() => {
          setOpenId(null);
          changed();
        }}
      />
    </>
  );
}

function ReviewDrawer(props: { reviewId: string | null; onClose(): void; onDone(): void }) {
  const app = useApp();
  const id = props.reviewId;
  const state = useAsync(
    (signal) => (id ? app.call("review/get", { review_id: id }, { signal }) : Promise.resolve(null)),
    [id],
  );

  const review = state.data?.review ?? null;
  const base = state.data?.base ?? null;
  const proposed = state.data?.proposed ?? null;

  return (
    <Drawer
      visible={id !== null}
      size="720px"
      header={review ? `审批 · ${review.kind}` : "审批详情"}
      footer={null}
      onClose={props.onClose}
    >
      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      {review ? (
        <div className="ck-drawer-body">
          <div className="ck-row-actions">
            <ReviewKindTag kind={review.kind} />
            <ReviewStatusTag status={review.status} />
          </div>
          <KV label="资产 id">{review.asset_id}</KV>
          <KV label="发起人">{review.requester_user_id}</KV>
          <KV label="发起时间">{formatTime(review.created_at)}</KV>
          <KV label="说明">{review.note || "—"}</KV>
          {review.reason ? <KV label="裁决理由">{review.reason}</KV> : null}
          {review.decided_at ? <KV label="裁决时间">{formatTime(review.decided_at)}</KV> : null}

          {review.kind === "update" ? (
            <div className="ck-section">
              <h3 className="ck-section-title">
                拟议变更（v{base?.version ?? "?"} → v{proposed?.version ?? "?"}）
              </h3>
              {proposed && base ? (
                <>
                  {proposed.title !== base.title ? (
                    <p>
                      标题：<span className="ck-muted">{base.title}</span> → {proposed.title}
                    </p>
                  ) : null}
                  <div className="ck-diff" role="table" aria-label="拟议变更差异">
                    {lineDiff(base.content, proposed.content).map((row, index) => (
                      <div key={index} className={`ck-diff-row ck-diff-${row.kind}`} role="row">
                        <span className="ck-diff-no">{row.oldNo ?? ""}</span>
                        <span className="ck-diff-no">{row.newNo ?? ""}</span>
                        <span className="ck-diff-text">
                          {row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  "}
                          {row.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="ck-muted">这个审批没有拟议正文（历史数据）。</p>
              )}
            </div>
          ) : proposed ? (
            <div className="ck-section">
              <h3 className="ck-section-title">拟议正文</h3>
              <ReadonlyContent text={proposed.content} />
            </div>
          ) : base ? (
            <div className="ck-section">
              <h3 className="ck-section-title">现行正文</h3>
              <ReadonlyContent text={base.content} />
            </div>
          ) : null}

          {review.status === "pending" ? (
            <DecideForm review={review} onDone={props.onDone} />
          ) : (
            <p className="ck-muted">这条审批已经结束，不能再裁决。</p>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

function DecideForm(props: { review: Review; onDone(): void }) {
  const app = useApp();
  const canDecide = canManageTeam(app.verification!, app.currentTeam);
  const isMine = props.review.requester_user_id === app.verification?.user.id;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await app.call("review/decide", {
        review_id: props.review.id,
        decision,
        ...(decision === "reject" ? { reason: reason.trim() } : {}),
      });
      MessagePlugin.success(decision === "approve" ? "已通过" : "已驳回");
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.call("review/withdraw", { review_id: props.review.id });
      MessagePlugin.success("已撤回");
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!canDecide) {
    return (
      <div className="ck-section">
        <h3 className="ck-section-title">裁决</h3>
        <p className="ck-muted">只有团队管理员或 System Admin 能裁决这条申请。</p>
        {isMine ? (
          <Button variant="outline" loading={busy} onClick={() => void withdraw()}>
            撤回我的申请
          </Button>
        ) : null}
        {error ? <ErrorBlock error={error} /> : null}
      </div>
    );
  }

  const reasonEmpty = reason.trim() === "";

  return (
    <div className="ck-section">
      <h3 className="ck-section-title">裁决</h3>
      {error ? <ErrorBlock error={error} /> : null}
      <Textarea
        value={reason}
        onChange={(value) => setReason(value)}
        placeholder="通过时可留空；驳回必须填写理由"
        autosize={{ minRows: 3, maxRows: 6 }}
      />
      <div className="ck-row-actions">
        <Button theme="primary" loading={busy} onClick={() => void decide("approve")}>
          通过
        </Button>
        <Button
          theme="danger"
          variant="outline"
          loading={busy}
          disabled={reasonEmpty}
          onClick={() => void decide("reject")}
        >
          驳回
        </Button>
        {isMine ? (
          <Button variant="text" loading={busy} onClick={() => void withdraw()}>
            撤回我的申请
          </Button>
        ) : null}
      </div>
      {reasonEmpty ? <p className="ck-field-hint">驳回要写明原因，对方会在详情里看到。</p> : null}
    </div>
  );
}
