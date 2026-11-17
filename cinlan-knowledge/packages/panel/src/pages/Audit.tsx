import { useState } from "react";
import { Button, Input, Table, Popup } from "tdesign-react";
import type { AuditRecord } from "@cinlan/knowledge-sdk";
import { useApp } from "../app/context.js";
import { EmptyState, ErrorBlock, LoadingState, PageHeader, useAsync } from "../app/ui.js";
import { formatTime } from "../lib/format.js";
import { canSeeAudit } from "../lib/roles.js";

const PAGE = 50;

/** 审计（panel-design.md §4.7）：只读；筛选 action / actor / target / 时间窗。 */
export function AuditPage() {
  const app = useApp();
  const canSee = canSeeAudit(app.verification!, app.currentTeam);

  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [rows, setRows] = useState<AuditRecord[] | null>(null);
  const [cursor, setCursor] = useState("");
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const query = {
    team: app.currentTeam ?? undefined,
    ...(action.trim() ? { action: action.trim() } : {}),
    ...(actor.trim() ? { actor_user_id: actor.trim() } : {}),
    ...(targetType.trim() ? { target_type: targetType.trim() } : {}),
    ...(targetId.trim() ? { target_id: targetId.trim() } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };

  const state = useAsync(
    (signal) =>
      canSee
        ? app.call("audit/list", { limit: PAGE, ...query }, { signal })
        : Promise.resolve(null),
    [version, canSee, app.currentTeam, action, actor, targetType, targetId, since, until],
  );

  const base = state.data?.items ?? [];
  const list = rows ?? base;

  const loadMore = async () => {
    const nextCursor = rows === null ? (state.data?.next_cursor ?? "") : cursor;
    if (nextCursor === "") return;
    setBusy(true);
    setMoreError(null);
    try {
      const page = await app.call("audit/list", { limit: PAGE, cursor: nextCursor, ...query });
      setRows([...(rows ?? base), ...page.items]);
      setCursor(page.next_cursor);
    } catch (cause) {
      setMoreError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!canSee) {
    return (
      <>
        <PageHeader title="审计" />
        <EmptyState title="当前身份看不到审计" hint="审计只对 System Admin 和团队管理员开放。" />
      </>
    );
  }

  const reset = () => {
    setRows(null);
    setCursor("");
    setVersion((v) => v + 1);
  };

  return (
    <>
      <PageHeader
        title="审计"
        description="只读的操作流水：谁、在什么时候、对哪个对象做了什么。detail 不含正文与密钥。"
        actions={
          <Button variant="outline" onClick={reset}>
            刷新
          </Button>
        }
      />

      <div className="ck-filters">
        <Input value={action} onChange={setAction} placeholder="action，如 asset/update" style={{ width: 200 }} />
        <Input value={actor} onChange={setActor} placeholder="actor user id" style={{ width: 180 }} />
        <Input value={targetType} onChange={setTargetType} placeholder="target_type" style={{ width: 140 }} />
        <Input value={targetId} onChange={setTargetId} placeholder="target_id" style={{ width: 180 }} />
        <input
          className="ck-input"
          type="datetime-local"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          aria-label="起始时间"
          style={{ width: 190 }}
        />
        <input
          className="ck-input"
          type="datetime-local"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          aria-label="截止时间"
          style={{ width: 190 }}
        />
        <Button variant="outline" onClick={reset}>
          查询
        </Button>
      </div>

      {state.loading && rows === null ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && list.length === 0 ? (
        <EmptyState title="没有匹配的审计记录" hint="放宽筛选条件或调整时间窗。" />
      ) : null}

      {list.length > 0 ? (
        <section className="ck-panel">
          <Table
            rowKey="id"
            data={list}
            hover
            columns={[
              { colKey: "id", title: "#", width: 70 },
              { colKey: "at", title: "时间", width: 150, cell: ({ row }) => formatTime(row.at) },
              { colKey: "action", title: "动作", width: 170, cell: ({ row }) => <code>{row.action}</code> },
              {
                colKey: "actor",
                title: "执行者",
                width: 230,
                cell: ({ row }) => (
                  <span className="ck-small">
                    {row.actor_user_id ?? "—"}
                    {row.actor_agent_id ? <span className="ck-muted"> · agent {row.actor_agent_id}</span> : null}
                  </span>
                ),
              },
              {
                colKey: "target",
                title: "对象",
                cell: ({ row }) =>
                  row.target_type ? (
                    <span className="ck-small">
                      {row.target_type}
                      {row.target_id ? <span className="ck-muted"> · {row.target_id}</span> : null}
                    </span>
                  ) : (
                    <span className="ck-muted">—</span>
                  ),
              },
              {
                colKey: "detail",
                title: "detail",
                width: 90,
                cell: ({ row }) =>
                  Object.keys(row.detail).length === 0 ? (
                    <span className="ck-muted">—</span>
                  ) : (
                    <Popup
                      content={<pre className="ck-code ck-code-detail">{JSON.stringify(row.detail, null, 2)}</pre>}
                      placement="left"
                    >
                      <Button variant="text" size="small">
                        查看
                      </Button>
                    </Popup>
                  ),
              },
            ]}
          />
          <div className="ck-loadmore">
            {(rows !== null ? cursor : (state.data?.next_cursor ?? "")) !== "" ? (
              <Button variant="outline" loading={busy} onClick={() => void loadMore()}>
                加载更多
              </Button>
            ) : (
              <span className="ck-muted">已到底</span>
            )}
          </div>
          {moreError ? <p className="ck-login-error">{moreError}</p> : null}
        </section>
      ) : null}
    </>
  );
}
