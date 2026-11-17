import { useState } from "react";
import { Button, Drawer, Input, Table, Tag, MessagePlugin } from "tdesign-react";
import { useApp, useNavigate } from "../app/context.js";
import { EmptyState, ErrorBlock, PageHeader } from "../app/ui.js";
import { formatTime } from "../lib/format.js";
import { buildPath } from "../lib/router.js";

const REVIEW_MODE_LABEL = { off: "免审", share: "共享审批", all: "全审批" } as const;

/** 团队列表（panel-design.md §4.4）：SA 看全部团队并可新建；其他人看自己所在的团队。 */
export function TeamsPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const v = app.verification!;

  // 两种身份都用 app.teams：context 已按身份分页拉全（core 的 listTeams 对非 SA 按成员收窄），
  // 页面不再重复请求。「新建团队」仍只对 SA 显示。
  const rows = app.teams;
  const myTeams = new Map(v.teams.map((t) => [t.team_id, t.role]));

  return (
    <>
      <PageHeader
        title="团队"
        description="团队是资产与配装的边界；审批策略与默认模板在这里配置。"
        actions={
          v.is_system_admin ? (
            <Button theme="primary" onClick={() => setCreating(true)}>
              新建团队
            </Button>
          ) : undefined
        }
      />

      {app.teamsError ? <ErrorBlock error={app.teamsError} /> : null}

      {rows.length === 0 && !app.teamsError ? (
        <EmptyState title="还没有团队" hint="请 System Admin 先建一个团队。" />
      ) : null}

      {rows.length > 0 ? (
        <section className="ck-panel">
        <Table
          rowKey="id"
          data={rows}
          hover
          columns={[
            {
              colKey: "title",
              title: "名称",
              cell: ({ row }) => (
                <span>
                  {row.title}
                  <span className="ck-muted"> · {row.name}</span>
                </span>
              ),
            },
            { colKey: "description", title: "描述", ellipsis: true, cell: ({ row }) => row.description || <span className="ck-muted">—</span> },
            {
              colKey: "review_mode",
              title: "审批策略",
              width: 110,
              cell: ({ row }) => <Tag variant="light">{REVIEW_MODE_LABEL[row.review_mode]}</Tag>,
            },
            {
              colKey: "my_role",
              title: "我的角色",
              width: 110,
              cell: ({ row }) => {
                const role = myTeams.get(row.id);
                return role ? (role === "admin" ? <Tag theme="primary" variant="light">管理员</Tag> : "成员") : <span className="ck-muted">非成员</span>;
              },
            },
            { colKey: "created_at", title: "创建时间", width: 150, cell: ({ row }) => formatTime(row.created_at) },
          ]}
          onRowClick={({ row }) => navigate(buildPath({ name: "team", id: row.id }))}
        />
        </section>
      ) : null}

      <CreateTeamDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          app.reloadTeams();
          navigate(buildPath({ name: "team", id }));
        }}
      />
    </>
  );
}

function CreateTeamDrawer(props: { open: boolean; onClose(): void; onCreated(id: string): void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = /^[a-z0-9][a-z0-9-]*$/.test(name.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await app.call("team/create", {
        name: name.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
      });
      MessagePlugin.success("团队已创建");
      props.onCreated(res.team.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer visible={props.open} size="480px" header="新建团队" footer={null} onClose={props.onClose}>
      <div className="ck-drawer-body">
        {error ? <p className="ck-login-error">{error}</p> : null}
        <label className="ck-field">
          <span className="ck-field-label">slug</span>
          <Input value={name} onChange={(value) => setName(value)} placeholder="kebab-case，如 core" />
          <span className={name.trim() && !nameOk ? "ck-error-strong" : "ck-field-hint"}>小写字母、数字、连字符。</span>
        </label>
        <label className="ck-field">
          <span className="ck-field-label">显示名</span>
          <Input value={title} onChange={(value) => setTitle(value)} placeholder="如 核心团队" />
        </label>
        <label className="ck-field">
          <span className="ck-field-label">描述</span>
          <Input value={description} onChange={(value) => setDescription(value)} placeholder="可选" />
        </label>
        <div className="ck-row-actions">
          <Button
            theme="primary"
            loading={busy}
            disabled={!nameOk || title.trim() === ""}
            onClick={() => void submit()}
          >
            创建
          </Button>
          <Button variant="outline" onClick={props.onClose}>
            取消
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
