import { useState } from "react";
import { Button, Drawer, Input, Select, Table, Textarea, MessagePlugin, Popconfirm, Tag } from "tdesign-react";
import type {
  Asset,
  AssetStatus,
  AssetType,
  AssetVersion,
  MemoryLayer,
  Visibility,
} from "@cinlan/knowledge-sdk";
import { useApp } from "../app/context.js";
import {
  AssetStatusTag,
  AssetTypeTag,
  CopyButton,
  EmptyState,
  ErrorBlock,
  LoadingState,
  PageHeader,
  ReadonlyContent,
  useAsync,
  VisibilityTag,
  KV,
  LockedAction,
  toApiError,
} from "../app/ui.js";
import { assetTypeLabel, formatTime, visibilityLabel } from "../lib/format.js";
import { ApiError } from "../lib/api.js";
import { lineDiff } from "../lib/diff.js";

const TYPE_OPTIONS: { label: string; value: AssetType }[] = [
  { label: "记忆", value: "memory" },
  { label: "技能", value: "skill" },
  { label: "Wiki", value: "wiki" },
  { label: "代码图", value: "codegraph" },
];

const STATUS_OPTIONS: { label: string; value: AssetStatus }[] = [
  { label: "草稿", value: "draft" },
  { label: "生效", value: "active" },
  { label: "已弃用", value: "deprecated" },
  { label: "已归档", value: "archived" },
];

const VISIBILITY_OPTIONS: { label: string; value: Visibility }[] = [
  { label: "私有", value: "private" },
  { label: "团队", value: "team" },
  { label: "受限", value: "restricted" },
  { label: "仅 Agent", value: "agent" },
];

export function AssetsPage() {
  const app = useApp();
  const team = app.currentTeam;

  const [type, setType] = useState<AssetType | undefined>();
  const [status, setStatus] = useState<AssetStatus | undefined>();
  const [visibility, setVisibility] = useState<Visibility | undefined>();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Asset[] | null>(null);
  const [cursor, setCursor] = useState("");
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);

  // 草稿式筛选：改筛选条件后按「筛选」重取，避免每键一次请求。
  const filter = { type, status, visibility, query };

  const state = useAsync(
    (signal) => {
      if (!team) return Promise.resolve({ items: [] as Asset[], next_cursor: "" });
      if (filter.query.trim() !== "") {
        return app
          .call(
            "asset/search",
            {
              query: filter.query.trim(),
              team,
              ...(filter.type ? { types: [filter.type] } : {}),
            },
            { signal },
          )
          .then((res) => ({
            items: res.hits.map(hitToAsset),
            next_cursor: "",
          }));
      }
      return app.call(
        "asset/list",
        {
          team,
          limit: 20,
          ...(filter.type ? { type: filter.type } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.visibility ? { visibility: filter.visibility } : {}),
        },
        { signal },
      );
    },
    [team, type, status, visibility, query, version],
  );

  const base = state.data?.items ?? [];
  const rows = items ?? base;

  const loadMore = async () => {
    const next = items ?? base;
    const nextCursor = items === null ? compactCursor(state.data?.next_cursor ?? "") : cursor;
    if (nextCursor === "") return;
    setBusy(true);
    setListError(null);
    try {
      const page = await app.call("asset/list", {
        team: team!,
        limit: 20,
        cursor: nextCursor,
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(visibility ? { visibility } : {}),
      });
      setItems([...next, ...page.items]);
      setCursor(page.next_cursor);
    } catch (cause) {
      setListError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const resetAnd = (fn: () => void) => {
    setItems(null);
    setCursor("");
    fn();
  };

  return (
    <>
      <PageHeader
        title="资产库"
        description="团队与个人的记忆、技能。只有过审的团队资产会进入配装。"
        actions={
          <>
            <Button variant="outline" onClick={() => resetAnd(() => setVersion((v) => v + 1))}>
              刷新
            </Button>
            <Button theme="primary" onClick={() => setCreating(true)}>
              新建资产
            </Button>
          </>
        }
      />

      <div className="ck-filters">
        <Input
          value={query}
          onChange={(value) => resetAnd(() => setQuery(value))}
          placeholder="搜索标题或正文（asset/search）"
          clearable
          style={{ width: 280 }}
        />
        <Select
          value={type}
          options={TYPE_OPTIONS}
          placeholder="类型"
          clearable
          onChange={(value) => resetAnd(() => setType(value as AssetType | undefined))}
          style={{ width: 140 }}
        />
        <Select
          value={status}
          options={STATUS_OPTIONS}
          placeholder="状态"
          clearable
          onChange={(value) => resetAnd(() => setStatus(value as AssetStatus | undefined))}
          style={{ width: 140 }}
        />
        <Select
          value={visibility}
          options={VISIBILITY_OPTIONS}
          placeholder="可见性"
          clearable
          onChange={(value) => resetAnd(() => setVisibility(value as Visibility | undefined))}
          style={{ width: 140 }}
        />
        {type || status || visibility || query ? (
          <Button
            variant="text"
            onClick={() =>
              resetAnd(() => {
                setType(undefined);
                setStatus(undefined);
                setVisibility(undefined);
                setQuery("");
              })
            }
          >
            清除筛选
          </Button>
        ) : null}
      </div>

      {state.loading && items === null ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && rows.length === 0 ? (
        <EmptyState
          title={query ? "没有匹配的资产" : "还没有资产"}
          hint={query ? "换个关键词，或清除筛选。" : "从本机导入（ck import）或在右上角新建一个私有资产。"}
          action={
            <Button theme="primary" onClick={() => setCreating(true)}>
              新建资产
            </Button>
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <section className="ck-panel">
          <Table
            rowKey="id"
            data={rows}
            loading={state.loading && items !== null}
            hover
            columns={[
              {
                colKey: "title",
                title: "标题",
                ellipsis: true,
                cell: ({ row }) => (
                  <span title={row.title}>
                    {row.title}
                    {row.name ? <span className="ck-muted"> · {row.name}</span> : null}
                  </span>
                ),
              },
              { colKey: "type", title: "类型", width: 90, cell: ({ row }) => <AssetTypeTag type={row.type} /> },
              {
                colKey: "visibility",
                title: "可见性",
                width: 100,
                cell: ({ row }) => <VisibilityTag visibility={row.visibility} />,
              },
              {
                colKey: "status",
                title: "状态",
                width: 100,
                cell: ({ row }) => <AssetStatusTag status={row.status} />,
              },
              { colKey: "current_version", title: "版本", width: 70, cell: ({ row }) => `v${row.current_version}` },
              {
                colKey: "updated_at",
                title: "更新时间",
                width: 150,
                cell: ({ row }) => formatTime(row.updated_at),
              },
            ]}
            onRowClick={({ row }) => setOpenAsset(row.id)}
          />
          <div className="ck-loadmore">
            {items !== null || compactCursor(state.data?.next_cursor ?? "") !== "" ? (
              <Button variant="outline" loading={busy} onClick={() => void loadMore()}>
                加载更多
              </Button>
            ) : (
              <span className="ck-muted">已到底</span>
            )}
          </div>
          {listError ? <ErrorBlock error={listError} onRetry={() => void loadMore()} /> : null}
        </section>
      ) : null}

      <AssetDrawer
        assetId={openAsset}
        onClose={() => setOpenAsset(null)}
        onChanged={() => resetAnd(() => setVersion((v) => v + 1))}
      />
      <CreateAssetDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          resetAnd(() => setVersion((v) => v + 1));
        }}
      />
    </>
  );
}

function compactCursor(cursor: string): string {
  return cursor.includes("?") ? cursor.slice(cursor.indexOf("?") + 1) : cursor;
}

/** asset/search 的命中行转成列表行（缺的字段按列表默认值补）。 */
function hitToAsset(hit: {
  asset_id: string;
  type: AssetType;
  title: string;
  summary: string;
  version: number;
  visibility: Visibility;
  owner: { id: string; name: string };
  team_id: string;
  deprecated: boolean;
  updated_at: string;
}): Asset {
  return {
    id: hit.asset_id,
    team_id: hit.team_id,
    type: hit.type,
    name: null,
    title: hit.title,
    summary: hit.summary,
    layer: null,
    tags: [],
    owner_user_id: hit.owner.id,
    visibility: hit.visibility,
    status: hit.deprecated ? "deprecated" : "active",
    current_version: hit.version,
    expires_at: null,
    usage_count: 0,
    last_used_at: null,
    source: { origin: "tool" },
    created_at: "",
    updated_at: hit.updated_at,
  };
}

/* ---------- 详情抽屉 ---------- */

function AssetDrawer(props: { assetId: string | null; onClose(): void; onChanged(): void }) {
  const app = useApp();
  const id = props.assetId;
  const [compareVersion, setCompareVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<ApiError | null>(null);

  const state = useAsync(
    (signal) => {
      if (!id) return Promise.resolve(null);
      return Promise.all([
        app.call("asset/get", { asset_id: id }, { signal }),
        app.call("asset/history", { asset_id: id }, { signal }),
      ]);
    },
    [id],
  );

  const detail = state.data?.[0] ?? null;
  const history: AssetVersion[] = state.data?.[1]?.versions ?? [];

  const rollbackTo = async (version: number): Promise<void> => {
    if (detail === null) return;
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      const out = await app.call("asset/rollback", { asset_id: detail.asset.id, version });
      if (out.status === "pending_review") {
        MessagePlugin.success("已提交回滚审批。");
      } else {
        MessagePlugin.success(`已回滚到 v${version}。`);
      }
      setCompareVersion(null);
      state.reload();
      props.onChanged();
    } catch (cause) {
      setRollbackError(toApiError(cause));
    } finally {
      setRollbackBusy(false);
    }
  };

  return (
    <Drawer
      visible={id !== null}
      size="640px"
      header={detail ? detail.asset.title : "资产详情"}
      onClose={() => {
        setEditing(false);
        setCompareVersion(null);
        props.onClose();
      }}
      footer={null}
    >
      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      {detail ? (
        <div className="ck-drawer-body">
          <div className="ck-row-actions">
            <AssetTypeTag type={detail.asset.type} />
            <VisibilityTag visibility={detail.asset.visibility} />
            <AssetStatusTag status={detail.asset.status} />
            <span className="ck-muted">v{detail.version.version}</span>
            <CopyButton text={detail.asset.id} label="复制 id" />
          </div>

          <KV label="Owner">{detail.asset.owner_user_id}</KV>
          <KV label="更新时间">{formatTime(detail.asset.updated_at)}</KV>
          <KV label="内容哈希">{(detail.version.content_hash || "").slice(0, 16)}…</KV>

          {editing ? (
            <EditForm
              version={detail.version}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                state.reload();
                props.onChanged();
              }}
            />
          ) : (
            <>
              <ReadonlyContent text={detail.version.content} />
              <Button variant="outline" onClick={() => setEditing(true)}>
                编辑正文
              </Button>
            </>
          )}

          <ShareForm
            asset={detail.asset}
            onDone={() => {
              state.reload();
              props.onChanged();
            }}
          />

          <StatusActions
            asset={detail.asset}
            onDone={() => {
              state.reload();
              props.onChanged();
            }}
          />

          <div className="ck-section">
            <h3 className="ck-section-title">版本历史</h3>
            {history.length <= 1 ? (
              <p className="ck-muted">只有一个版本。</p>
            ) : (
              <>
                <Select
                  value={compareVersion ?? undefined}
                  placeholder="选一个旧版本与现行版本对比"
                  options={history
                    .filter((v) => v.version !== detail.version.version)
                    .map((v) => ({ label: `v${v.version} · ${formatTime(v.created_at)}`, value: v.version }))}
                  onChange={(value) => setCompareVersion(typeof value === "number" ? value : null)}
                  style={{ width: 320 }}
                />
                {compareVersion !== null ? (
                  <>
                    {rollbackError ? <ErrorBlock error={rollbackError} /> : null}
                    <Popconfirm
                      content={`把现行版本回滚到 v${compareVersion}？回滚本身走 update 审批（review kind=update），人审裁决。`}
                      onConfirm={() => void rollbackTo(compareVersion)}
                    >
                      <Button variant="outline" theme="warning" size="small" loading={rollbackBusy} style={{ marginTop: 8, marginBottom: 8 }}>
                        回滚到 v{compareVersion}
                      </Button>
                    </Popconfirm>
                    <VersionDiff assetId={detail.asset.id} version={compareVersion} current={detail.version} />
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

function VersionDiff(props: { assetId: string; version: number; current: AssetVersion }) {
  const app = useApp();
  const state = useAsync(
    (signal) => app.call("asset/get", { asset_id: props.assetId, version: props.version }, { signal }),
    [props.assetId, props.version],
  );
  if (state.loading) return <LoadingState text="取旧版本…" />;
  if (state.error) return <ErrorBlock error={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  const rows = lineDiff(state.data.version.content, props.current.content);
  return (
    <div className="ck-diff" role="table" aria-label="版本差异">
      {rows.map((row, index) => (
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
  );
}

function EditForm(props: { version: AssetVersion; onCancel(): void; onSaved(): void }) {
  const app = useApp();
  const [title, setTitle] = useState(props.version.title);
  const [content, setContent] = useState(props.version.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await app.call("asset/update", {
        asset_id: props.version.asset_id,
        base_version: props.version.version,
        title,
        content,
        change_note: "panel 编辑",
      });
      if ("status" in res) {
        MessagePlugin.info("改动已进入审批队列，等待团队管理员处理。");
      } else {
        MessagePlugin.success("已保存新版本。");
      }
      props.onSaved();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const tooBig = new TextEncoder().encode(content).length > 256 * 1024;

  return (
    <div className="ck-section">
      {error ? <ErrorBlock error={error} /> : null}
      <Input value={title} onChange={(value) => setTitle(value)} placeholder="标题" />
      <Textarea
        value={content}
        onChange={(value) => setContent(value)}
        autosize={{ minRows: 12, maxRows: 30 }}
        placeholder="正文"
      />
      <p className={tooBig ? "ck-error-strong" : "ck-muted"}>
        {tooBig ? "超过 256 KiB，hub 会拒绝（PAYLOAD_TOO_LARGE）。" : `当前 ${new TextEncoder().encode(content).length} 字节`}
      </p>
      <div className="ck-row-actions">
        <Button theme="primary" loading={busy} disabled={tooBig} onClick={() => void save()}>
          保存
        </Button>
        <Button variant="outline" onClick={props.onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function ShareForm(props: { asset: Asset; onDone(): void }) {
  const app = useApp();
  const [visibility, setVisibility] = useState<Visibility>(props.asset.visibility);
  const [note, setNote] = useState("");
  const [aclSubject, setAclSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const acl = visibility === "restricted" && aclSubject.trim() !== ""
        ? [{ subject_type: "user" as const, subject_id: aclSubject.trim(), permission: "read" as const }]
        : undefined;
      const res = await app.call("asset/set-visibility", {
        asset_id: props.asset.id,
        visibility,
        note: note.trim() || undefined,
        ...(acl !== undefined ? { acl } : {}),
      });
      MessagePlugin.success(
        res.status === "pending_review" ? "已提交审批，等待团队管理员" : "可见性已更新",
      );
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const needsNote = visibility === "team" && visibility !== props.asset.visibility;
  const needsAcl = visibility === "restricted" && aclSubject.trim() === "";

  return (
    <div className="ck-section">
      <h3 className="ck-section-title">共享</h3>
      {error ? <ErrorBlock error={error} /> : null}
      <div className="ck-row-actions">
        <Select
          value={visibility}
          options={VISIBILITY_OPTIONS.map((o) => ({ label: `${o.label}（${o.value}）`, value: o.value }))}
          onChange={(value) => setVisibility(value as Visibility)}
          style={{ width: 200 }}
        />
        <Input value={note} onChange={(value) => setNote(value)} placeholder="给审批人的说明" style={{ flex: 1 }} />
        <Button
          variant="outline"
          loading={busy}
          disabled={visibility === props.asset.visibility || needsAcl}
          onClick={() => void submit()}
        >
          {needsNote ? "申请共享到团队" : "更新可见性"}
        </Button>
      </div>
      {visibility === "restricted" ? (
        <div className="ck-row-actions" style={{ marginTop: 8 }}>
          <Input
            value={aclSubject}
            onChange={(value) => setAclSubject(value)}
            placeholder="授予对象（user slug，如 alice）"
            style={{ flex: 1 }}
          />
          <p className="ck-muted" style={{ margin: 0, alignSelf: "center" }}>restricted 必须带 ACL（谁可以读）</p>
        </div>
      ) : null}
      <p className="ck-muted">共享到团队按团队策略可能进入审批（pending_review）。</p>
    </div>
  );
}

function StatusActions(props: { asset: Asset; onDone(): void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = async (action: "activate" | "deprecate" | "archive" | "restore" | "purge") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "purge") await app.call("asset/purge", { asset_id: props.asset.id });
      else await app.call("asset/set-status", { asset_id: props.asset.id, action });
      MessagePlugin.success("已更新");
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ck-section">
      <h3 className="ck-section-title">状态</h3>
      {error ? <ErrorBlock error={error} /> : null}
      <div className="ck-row-actions">
        {props.asset.status !== "active" ? (
          <Button variant="outline" loading={busy} onClick={() => void run("activate")}>
            生效
          </Button>
        ) : null}
        {props.asset.status === "active" ? (
          <Button variant="outline" loading={busy} onClick={() => void run("deprecate")}>
            弃用
          </Button>
        ) : null}
        {props.asset.status !== "archived" ? (
          <Button variant="outline" loading={busy} onClick={() => void run("archive")}>
            归档
          </Button>
        ) : null}
        {props.asset.status === "archived" ? (
          <Button variant="outline" loading={busy} onClick={() => void run("restore")}>
            恢复
          </Button>
        ) : null}
        {props.asset.status === "archived" ? (
          <Popconfirm content="彻底删除不可恢复，确认？" onConfirm={() => void run("purge")}>
            <Button theme="danger" variant="outline" loading={busy}>
              永久删除
            </Button>
          </Popconfirm>
        ) : (
          <LockedAction label="永久删除" reason="只有 archived 资产可以 purge" />
        )}
      </div>
    </div>
  );
}

/* ---------- 新建抽屉 ---------- */

function CreateAssetDrawer(props: { open: boolean; onClose(): void; onCreated(): void }) {
  const app = useApp();
  const [type, setType] = useState<AssetType>("memory");
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [layer, setLayer] = useState<MemoryLayer | undefined>("core");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.call("asset/create", {
        team: app.currentTeam ?? undefined,
        type,
        title: title.trim(),
        content,
        name: type === "skill" ? name.trim() || undefined : undefined,
        summary: summary.trim() || undefined,
        tags: tags.trim() === "" ? undefined : tags.split(/[,，\s]+/).filter(Boolean),
        layer: type === "memory" ? layer : undefined,
      });
      MessagePlugin.success("已创建（private）");
      setTitle("");
      setName("");
      setSummary("");
      setContent("");
      setTags("");
      props.onCreated();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const bytes = new TextEncoder().encode(content).length;

  return (
    <Drawer visible={props.open} size="640px" header="新建资产" footer={null} onClose={props.onClose}>
      <div className="ck-drawer-body">
        {error ? <ErrorBlock error={error} /> : null}
        <label className="ck-field">
          <span className="ck-field-label">类型</span>
          <Select
            value={type}
            options={TYPE_OPTIONS.map((o) => ({ label: `${o.label}（${o.value}）`, value: o.value }))}
            onChange={(value) => setType(value as AssetType)}
          />
        </label>
        <label className="ck-field">
          <span className="ck-field-label">标题</span>
          <Input value={title} onChange={(value) => setTitle(value)} placeholder="一句话说明这条资产" />
        </label>
        {type === "skill" ? (
          <label className="ck-field">
            <span className="ck-field-label">skill 名</span>
            <Input value={name} onChange={(value) => setName(value)} placeholder="kebab-case，如 code-review" />
          </label>
        ) : null}
        {type === "memory" ? (
          <label className="ck-field">
            <span className="ck-field-label">层</span>
            <Select
              value={layer}
              options={[
                { label: "core", value: "core" },
                { label: "profile", value: "profile" },
                { label: "atom", value: "atom" },
              ]}
              onChange={(value) => setLayer(value as MemoryLayer)}
            />
          </label>
        ) : null}
        <label className="ck-field">
          <span className="ck-field-label">摘要</span>
          <Input value={summary} onChange={(value) => setSummary(value)} placeholder="可选；进检索与列表" />
        </label>
        <label className="ck-field">
          <span className="ck-field-label">标签</span>
          <Input value={tags} onChange={(value) => setTags(value)} placeholder="逗号或空格分隔" />
        </label>
        <label className="ck-field">
          <span className="ck-field-label">正文</span>
          <Textarea
            value={content}
            onChange={(value) => setContent(value)}
            autosize={{ minRows: 12, maxRows: 30 }}
            placeholder="正文（纯文本或 Markdown 源码）"
          />
          <span className={bytes > 256 * 1024 ? "ck-error-strong" : "ck-field-hint"}>
            {bytes} 字节 / 上限 256 KiB
          </span>
        </label>
        <div className="ck-row-actions">
          <Button
            theme="primary"
            loading={busy}
            disabled={title.trim() === "" || content === "" || bytes > 256 * 1024}
            onClick={() => void submit()}
          >
            创建
          </Button>
          <Button variant="outline" onClick={props.onClose}>
            取消
          </Button>
        </div>
        <p className="ck-muted">新建资产默认私有；共享到团队按团队策略可能进入审批。</p>
        <p className="ck-muted">标签：{tags || "—"}；类型：{assetTypeLabel(type)}；可见性：{visibilityLabel("private")}</p>
        <Tag variant="light" theme="default">
          新建后可在详情里改可见性
        </Tag>
      </div>
    </Drawer>
  );
}
