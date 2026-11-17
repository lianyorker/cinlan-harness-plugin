import { useState } from "react";
import { Button, Input, Select, Table, Tag, MessagePlugin, Popconfirm, Tabs } from "tdesign-react";
import type { AclEntry, AclPermission, AclSubjectType, Asset, User, UserKeyInfo } from "@cinlan/knowledge-sdk";
import { useApp } from "../app/context.js";
import {
  EmptyState,
  ErrorBlock,
  KeyReveal,
  LoadingState,
  PageHeader,
  PermissionTag,
  useAsync,
  toApiError,
} from "../app/ui.js";
import { formatTime } from "../lib/format.js";
import { ApiError } from "../lib/api.js";

/** 访问控制（panel-design.md §4.5）：ACL、我的 key、SA 用户管理。 */
export function AccessPage() {
  const app = useApp();
  const [tab, setTab] = useState<string | number>("keys");
  const isSA = app.verification?.is_system_admin ?? false;

  return (
    <>
      <PageHeader
        title="访问控制"
        description="谁能读、谁能管；key 只在创建时显示一次。"
      />
      <Tabs value={tab} onChange={(value) => setTab(value)}>
        <Tabs.TabPanel value="keys" label="我的 key">
          <MyKeys />
        </Tabs.TabPanel>
        <Tabs.TabPanel value="acl" label="资产 ACL">
          <AclPanel />
        </Tabs.TabPanel>
        {isSA ? (
          <Tabs.TabPanel value="users" label="用户">
            <UsersPanel />
          </Tabs.TabPanel>
        ) : null}
      </Tabs>
    </>
  );
}

/* ---------- 我的 key ---------- */

function MyKeys() {
  const app = useApp();
  const me = app.verification!.user;
  const [version, setVersion] = useState(0);
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const state = useAsync((signal) => app.call("user-key/list", { user_id: me.id }, { signal }), [me.id, version]);
  const keys: UserKeyInfo[] = state.data?.keys ?? [];
  const active = keys.filter((k) => k.revoked_at === null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await app.call("user-key/create", { user_id: me.id, name: name.trim() });
      setRevealed(res.key.key);
      setName("");
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: UserKeyInfo) => {
    setError(null);
    try {
      await app.call("user-key/revoke", { key_id: key.id, user_id: me.id });
      MessagePlugin.success(`已吊销 ${key.name}`);
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(toApiError(cause));
    }
  };

  return (
    <div className="ck-panel">
      {error ? <ErrorBlock error={error} /> : null}
      <div className="ck-row-actions">
        <Input value={name} onChange={(value) => setName(value)} placeholder="key 名称，如 laptop" style={{ width: 240 }} />
        <Button theme="primary" loading={busy} disabled={name.trim() === ""} onClick={() => void create()}>
          新建 key
        </Button>
      </div>
      <p className="ck-muted">同一用户可持有多把 key（换机时先建新的再吊销旧的）。明文只在创建响应里出现一次。</p>

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && keys.length === 0 ? (
        <EmptyState title="还没有 key" hint="上面的表单建一把。" />
      ) : null}
      {keys.length > 0 ? (
        <Table
          rowKey="id"
          data={keys}
          columns={[
            { colKey: "name", title: "名称" },
            { colKey: "prefix", title: "前缀", width: 140, cell: ({ row }) => <code>{row.prefix}…</code> },
            { colKey: "created_at", title: "创建", width: 150, cell: ({ row }) => formatTime(row.created_at) },
            { colKey: "last_used_at", title: "最近使用", width: 150, cell: ({ row }) => formatTime(row.last_used_at) },
            { colKey: "expires_at", title: "过期", width: 150, cell: ({ row }) => (row.expires_at ? formatTime(row.expires_at) : <span className="ck-muted">不过期</span>) },
            {
              colKey: "state",
              title: "状态",
              width: 90,
              cell: ({ row }) =>
                row.revoked_at ? <Tag variant="light" theme="default">已吊销</Tag> : <Tag variant="light" theme="success">有效</Tag>,
            },
            {
              colKey: "ops",
              title: "",
              width: 80,
              cell: ({ row }) =>
                row.revoked_at ? null : (
                  <Popconfirm content={`吊销 ${row.name}？使用它的宿主会立即失效。`} onConfirm={() => void revoke(row)}>
                    <Button variant="text" size="small" theme="danger">
                      吊销
                    </Button>
                  </Popconfirm>
                ),
            },
          ]}
        />
      ) : null}
      {active.length === 0 && keys.length > 0 ? <p className="ck-muted">当前没有有效 key，宿主会连不上 hub。</p> : null}

      <KeyReveal open={revealed !== null} text={revealed ?? ""} onClose={() => setRevealed(null)} />
      <p className="ck-muted ck-small">当前登录用的 key 若在这里吊销，本页会在下一次请求时退回登录页。</p>
    </div>
  );
}

/* ---------- 资产 ACL ---------- */

function AclPanel() {
  const app = useApp();
  const [assetId, setAssetId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const assets = useAsync(
    (signal) =>
      app.currentTeam
        ? app.call("asset/list", { team: app.currentTeam, limit: 100 }, { signal })
        : Promise.resolve({ items: [] as Asset[], next_cursor: "" }),
    [app.currentTeam],
  );

  const acl = useAsync(
    (signal) => (assetId ? app.call("acl/list", { asset_id: assetId }, { signal }) : Promise.resolve(null)),
    [assetId, version],
  );

  const check = useAsync(
    (signal) => (assetId ? app.call("acl/check", { asset_id: assetId }, { signal }) : Promise.resolve(null)),
    [assetId, version],
  );

  const entries: AclEntry[] = acl.data?.acl ?? [];

  return (
    <div className="ck-panel">
      <div className="ck-row-actions">
        <Select
          value={assetId ?? undefined}
          options={(assets.data?.items ?? []).map((a) => ({ label: a.title, value: a.id }))}
          placeholder="选一条资产看它的 ACL"
          filterable
          clearable
          loading={assets.loading}
          onChange={(value) => setAssetId(typeof value === "string" ? value : null)}
          style={{ width: 360 }}
        />
      </div>

      {assets.error ? <ErrorBlock error={assets.error} onRetry={assets.reload} /> : null}
      {assetId === null ? (
        <EmptyState title="先选一条资产" hint="ACL 是按资产授权的；asset 所有者与团队角色另有隐式权限。" />
      ) : (
        <>
          {acl.loading ? <LoadingState /> : null}
          {acl.error ? <ErrorBlock error={acl.error} onRetry={acl.reload} /> : null}
          {check.data ? (
            <p className="ck-muted">
              我的权限：读 {check.data.read ? "有" : "无"} · 管 {check.data.manage ? "有" : "无"}
              {check.data.via ? `（来源：${check.data.via}）` : ""}
            </p>
          ) : null}

          <GrantForm assetId={assetId} onDone={() => setVersion((v) => v + 1)} />

          {entries.length === 0 && !acl.loading ? (
            <EmptyState title="没有显式 ACL" hint="共享给团队（visibility=team）走的是可见性，不是 ACL。" />
          ) : null}
          {entries.length > 0 ? (
            <Table
              rowKey="row_key"
              data={entries.map((entry) => ({
                ...entry,
                // AclEntry 没有 id；TDesign rowKey 只接受字符串字段名，这里拼一个稳定键。
                row_key: `${entry.asset_id}:${entry.subject_type}:${entry.subject_id}:${entry.permission}`,
              }))}
              columns={[
                { colKey: "subject_type", title: "主体", width: 100, cell: ({ row }) => subjectLabel(row.subject_type) },
                { colKey: "subject_id", title: "对象", cell: ({ row }) => <code>{row.subject_id}</code> },
                { colKey: "permission", title: "权限", width: 90, cell: ({ row }) => <PermissionTag permission={row.permission} /> },
                { colKey: "granted_by", title: "授予人", width: 180, cell: ({ row }) => row.granted_by },
                { colKey: "created_at", title: "时间", width: 150, cell: ({ row }) => formatTime(row.created_at) },
                {
                  colKey: "ops",
                  title: "",
                  width: 80,
                  cell: ({ row }) => (
                    <Popconfirm
                      content="撤销这条授权？"
                      onConfirm={() => void revokeAcl(app, assetId, row, () => setVersion((v) => v + 1))}
                    >
                      <Button variant="text" size="small" theme="danger">
                        撤销
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function subjectLabel(type: AclSubjectType): string {
  return type === "user" ? "用户" : type === "role" ? "角色" : "Agent";
}

async function revokeAcl(
  app: ReturnType<typeof useApp>,
  assetId: string,
  entry: AclEntry,
  done: () => void,
) {
  try {
    await app.call("acl/revoke", {
      asset_id: assetId,
      subject_type: entry.subject_type,
      subject_id: String(entry.subject_id),
      permission: entry.permission,
    });
    MessagePlugin.success("已撤销");
    done();
  } catch (cause) {
    MessagePlugin.error(toApiError(cause).detail || toApiError(cause).code);
  }
}

function GrantForm(props: { assetId: string; onDone(): void }) {
  const app = useApp();
  const [subjectType, setSubjectType] = useState<AclSubjectType>("user");
  const [subjectId, setSubjectId] = useState("");
  const [permission, setPermission] = useState<AclPermission>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.call("acl/grant", {
        asset_id: props.assetId,
        subject_type: subjectType,
        subject_id: subjectId.trim(),
        permission,
      });
      MessagePlugin.success("已授权");
      setSubjectId("");
      props.onDone();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ck-section">
      {error ? <ErrorBlock error={error} /> : null}
      <div className="ck-row-actions">
        <Select
          value={subjectType}
          options={[
            { label: "用户", value: "user" },
            { label: "角色", value: "role" },
            { label: "Agent", value: "agent" },
          ]}
          onChange={(value) => setSubjectType(value as AclSubjectType)}
          style={{ width: 110 }}
        />
        <Input
          value={subjectId}
          onChange={(value) => setSubjectId(value)}
          placeholder={subjectType === "role" ? "member 或 admin" : subjectType === "user" ? "user slug 或 id" : "agent id"}
          style={{ flex: 1 }}
        />
        <Select
          value={permission}
          options={[
            { label: "读取", value: "read" },
            { label: "管理", value: "manage" },
          ]}
          onChange={(value) => setPermission(value as AclPermission)}
          style={{ width: 110 }}
        />
        <Button variant="outline" loading={busy} disabled={subjectId.trim() === ""} onClick={() => void submit()}>
          授权
        </Button>
      </div>
    </div>
  );
}

/* ---------- SA 用户管理 ---------- */

function UsersPanel() {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", display_name: "", key_name: "default", is_system_admin: false });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const state = useAsync(
    (signal) =>
      app.call("user/list", { limit: 100, ...(query.trim() ? { query: query.trim() } : {}) }, { signal }),
    [query, version],
  );

  const users: User[] = state.data?.items ?? [];

  const createUser = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await app.call("user/create-with-key", {
        name: newUser.name.trim(),
        display_name: newUser.display_name.trim(),
        key_name: newUser.key_name.trim() || "default",
        is_system_admin: newUser.is_system_admin || undefined,
      });
      setRevealed(res.key.key);
      setCreating(false);
      setNewUser({ name: "", display_name: "", key_name: "default", is_system_admin: false });
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleDisabled = async (user: User) => {
    setError(null);
    try {
      await app.call("user/disable", { user_id: user.id, disabled: user.status !== "disabled" });
      MessagePlugin.success(user.status === "disabled" ? "已启用" : "已禁用");
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(toApiError(cause));
    }
  };

  const issueKey = async (user: User) => {
    setError(null);
    try {
      const res = await app.call("user-key/create", { user_id: user.id, name: `for-${user.name}` });
      setRevealed(res.key.key);
    } catch (cause) {
      setError(toApiError(cause));
    }
  };

  return (
    <div className="ck-panel">
      {error ? <ErrorBlock error={error} /> : null}
      <div className="ck-row-actions">
        <Input value={query} onChange={(value) => setQuery(value)} placeholder="搜名字" style={{ width: 240 }} clearable />
        <Button theme="primary" variant="outline" onClick={() => setCreating((c) => !c)}>
          {creating ? "收起" : "新建用户"}
        </Button>
      </div>

      {creating ? (
        <div className="ck-section ck-form-grid">
          <label className="ck-field">
            <span className="ck-field-label">slug</span>
            <Input value={newUser.name} onChange={(value) => setNewUser((u) => ({ ...u, name: value }))} placeholder="kebab-case" />
          </label>
          <label className="ck-field">
            <span className="ck-field-label">显示名</span>
            <Input value={newUser.display_name} onChange={(value) => setNewUser((u) => ({ ...u, display_name: value }))} />
          </label>
          <label className="ck-field">
            <span className="ck-field-label">首个 key 名称</span>
            <Input value={newUser.key_name} onChange={(value) => setNewUser((u) => ({ ...u, key_name: value }))} />
          </label>
          <label className="ck-check">
            <input
              type="checkbox"
              checked={newUser.is_system_admin}
              onChange={(e) => setNewUser((u) => ({ ...u, is_system_admin: e.target.checked }))}
            />
            <span>System Admin</span>
          </label>
          <div className="ck-row-actions">
            <Button
              theme="primary"
              loading={busy}
              disabled={!/^[a-z0-9][a-z0-9-]*$/.test(newUser.name.trim()) || newUser.display_name.trim() === ""}
              onClick={() => void createUser()}
            >
              创建并签发 key
            </Button>
          </div>
          <p className="ck-muted">新用户的 key 明文只在这里出现一次。</p>
        </div>
      ) : null}

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && users.length === 0 ? <EmptyState title="没有用户" hint="换个搜索词，或新建。" /> : null}
      {users.length > 0 ? (
        <Table
          rowKey="id"
          data={users}
          columns={[
            { colKey: "name", title: "slug" },
            { colKey: "display_name", title: "显示名" },
            {
              colKey: "is_system_admin",
              title: "SA",
              width: 70,
              cell: ({ row }) => (row.is_system_admin ? <Tag variant="light" theme="primary">SA</Tag> : <span className="ck-muted">—</span>),
            },
            {
              colKey: "status",
              title: "状态",
              width: 90,
              cell: ({ row }) => (row.status === "active" ? <Tag variant="light" theme="success">有效</Tag> : <Tag variant="light" theme="default">已禁用</Tag>),
            },
            { colKey: "created_at", title: "创建", width: 150, cell: ({ row }) => formatTime(row.created_at) },
            {
              colKey: "ops",
              title: "",
              width: 190,
              cell: ({ row }) => (
                <div className="ck-row-actions">
                  <Button variant="text" size="small" onClick={() => void issueKey(row)}>
                    签发 key
                  </Button>
                  <Popconfirm
                    content={row.status === "disabled" ? "重新启用这个用户？" : "禁用后该用户所有 key 立即失效。继续？"}
                    onConfirm={() => void toggleDisabled(row)}
                  >
                    <Button variant="text" size="small" theme="danger">
                      {row.status === "disabled" ? "启用" : "禁用"}
                    </Button>
                  </Popconfirm>
                </div>
              ),
            },
          ]}
        />
      ) : null}

      <KeyReveal open={revealed !== null} text={revealed ?? ""} onClose={() => setRevealed(null)} />
    </div>
  );
}
