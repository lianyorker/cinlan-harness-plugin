import { useState } from "react";
import { Button, Drawer, Input, Popconfirm, Select, Table, MessagePlugin } from "tdesign-react";
import type { Asset } from "@cinlan/knowledge-sdk";
import { useApp } from "../app/context.js";
import { EmptyState, ErrorBlock, LoadingState, PageHeader, ReadonlyContent, toApiError, useAsync } from "../app/ui.js";
import { formatTime } from "../lib/format.js";
import { ApiError } from "../lib/api.js";

/**
 * 收件箱（O-7 自动沉淀的采纳面，auto-distill.md §3）：`session/report` 落下的
 * 私有草稿在这里裁决——采纳（activate，可选申请共享）、丢弃（archive）。
 * 草稿仅 owner 可见（access.ts 的 draft 谓词），他人的收件箱天然是空的。
 */

const DRAFT_TITLE = "沉淀草稿";
const DRAFT_HINT = "会话里模型报上来的候选（knowledge_session_report）；采纳前只有你能看到。";

export function InboxPage() {
  const app = useApp();
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const state = useAsync(
    (signal) =>
      app.currentTeam
        ? app.call("asset/list", { team: app.currentTeam, status: "draft", limit: 100 }, { signal })
        : Promise.resolve({ items: [] as Asset[], next_cursor: "" }),
    [app.currentTeam, version],
  );

  const rows = state.data?.items ?? [];
  const emptyTitle = "收件箱是空的";

  return (
    <>
      <PageHeader title={DRAFT_TITLE} description={DRAFT_HINT} />
      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && rows.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          hint="宿主会话里有沉淀价值的结论会经 knowledge_session_report 落到这里；采纳后才进检索。"
        />
      ) : null}

      {rows.length > 0 ? (
        <section className="ck-panel">
          <Table
            rowKey="id"
            data={rows}
            hover
            columns={[
              { colKey: "title", title: "标题", ellipsis: true },
              { colKey: "type", title: "类型", width: 90, cell: ({ row }) => <span>{row.type === "memory" ? "记忆" : row.type}</span> },
              { colKey: "layer", title: "层", width: 90, cell: ({ row }) => <span className="ck-muted">{row.layer ?? "—"}</span> },
              { colKey: "created_at", title: "报入时间", width: 160, cell: ({ row }) => formatTime(row.created_at) },
              {
                colKey: "ops",
                title: "",
                width: 120,
                cell: ({ row }) => (
                  <Button variant="text" size="small" theme="primary" onClick={() => setOpenId(row.id)}>
                    处理
                  </Button>
                ),
              },
            ]}
            onRowClick={({ row }) => setOpenId(row.id)}
          />
        </section>
      ) : null}

      <DraftDrawer
        assetId={openId}
        onClose={() => setOpenId(null)}
        onDone={() => {
          setOpenId(null);
          setVersion((v) => v + 1);
        }}
      />
    </>
  );
}

function DraftDrawer(props: { assetId: string | null; onClose(): void; onDone(): void }) {
  const app = useApp();
  const [visibility, setVisibility] = useState<"keep" | "team">("keep");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const state = useAsync(
    (signal) => (props.assetId ? app.call("asset/get", { asset_id: props.assetId }, { signal }) : Promise.resolve(null)),
    [props.assetId],
  );

  const detail = state.data ?? null;
  const asset = detail?.asset ?? null;
  const content = detail?.version?.content ?? "";

  const adopt = async () => {
    if (asset === null) return;
    setBusy(true);
    setError(null);
    try {
      const out = await app.call("inbox/adopt", {
        asset_id: asset.id,
        ...(visibility === "team" ? { visibility: "team", note: note.trim() || undefined } : {}),
      });
      if (out.review_id !== null && out.review_id !== undefined) {
        MessagePlugin.success("已采纳；共享申请进入审批队列。");
      } else {
        MessagePlugin.success(visibility === "team" ? "已采纳并共享给团队。" : "已采纳（保持私有）。");
      }
      setNote("");
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (asset === null) return;
    setBusy(true);
    setError(null);
    try {
      await app.call("asset/set-status", { asset_id: asset.id, action: "archive", note: "草稿丢弃" });
      MessagePlugin.success("已丢弃（归档）。");
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      visible={props.assetId !== null}
      size="640px"
      header={asset ? `草稿 · ${asset.title}` : "草稿"}
      footer={null}
      onClose={props.onClose}
    >
      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      {asset ? (
        <div className="ck-drawer-body">
          {error ? <ErrorBlock error={error} /> : null}
          <ReadonlyContent text={content} />
          <div className="ck-section">
            <h3 className="ck-section-title">采纳</h3>
            <div className="ck-row-actions">
              <Select
                value={visibility}
                options={[
                  { label: "保持私有", value: "keep" },
                  { label: "同时申请共享给团队", value: "team" },
                ]}
                onChange={(value) => setVisibility(value === "team" ? "team" : "keep")}
                style={{ width: 220 }}
              />
              <Button theme="primary" loading={busy} onClick={() => void adopt()}>
                采纳
              </Button>
            </div>
            {visibility === "team" ? (
              <div className="ck-row-actions" style={{ marginTop: 8 }}>
                <Input
                  value={note}
                  onChange={(value) => setNote(value)}
                  placeholder="给审批人的说明（可留空）"
                  style={{ flex: 1 }}
                />
              </div>
            ) : null}
            <p className="ck-muted" style={{ marginTop: 8 }}>
              采纳后草稿转正进入检索；共享到团队按团队策略可能需要管理员审批。
            </p>
          </div>
          <div className="ck-section">
            <h3 className="ck-section-title">丢弃</h3>
            <Popconfirm content="丢弃即归档，之后可在资产库里恢复。继续？" onConfirm={() => void discard()}>
              <Button variant="outline" theme="danger" loading={busy}>
                丢弃这条草稿
              </Button>
            </Popconfirm>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
