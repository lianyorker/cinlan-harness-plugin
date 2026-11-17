import { useState } from "react";
import { Button, Drawer, Input, Select, Switch, Table, Tag, MessagePlugin } from "tdesign-react";
import type { Agent } from "@cinlan/knowledge-sdk";
import { useApp, useNavigate } from "../app/context.js";
import {
  AgentStatusTag,
  EmptyState,
  ErrorBlock,
  LoadingState,
  PageHeader,
  useAsync,
} from "../app/ui.js";
import { buildPath } from "../lib/router.js";
import { formatTime, hostLabel } from "../lib/format.js";
import { HostPicker } from "../components/HostPicker.js";

/** Agent 列表（panel-design.md §4.3）：按团队列出，点行进详情页（可深链）。 */
export function AgentsPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);

  const state = useAsync(
    (signal) =>
      app.call(
        "agent/list",
        {
          limit: 100,
          team: app.currentTeam ?? undefined,
          include_archived: includeArchived || undefined,
        },
        { signal },
      ),
    [app.currentTeam, includeArchived, version],
  );

  const rows = state.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Agent 配装"
        description="每个宿主会话对应一个 Agent；配装决定它的会话里装进哪些记忆与技能。"
        actions={
          <>
            <label className="ck-check">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              <span>含已归档</span>
            </label>
            <Button theme="primary" onClick={() => setCreating(true)}>
              新建 Agent
            </Button>
          </>
        }
      />

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}

      {!state.loading && !state.error && rows.length === 0 ? (
        <EmptyState
          title="这个团队还没有 Agent"
          hint="在宿主里跑一次 ck setup（会自动 agent/ensure），或在这里手工建一个。"
          action={
            <Button theme="primary" onClick={() => setCreating(true)}>
              新建 Agent
            </Button>
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <section className="ck-panel">
        <Table
          rowKey="id"
          data={rows}
          hover
          columns={[
            {
              colKey: "name",
              title: "名称",
              cell: ({ row }) => (
                <span>
                  {row.name}
                  {row.is_template ? (
                    <Tag variant="light" theme="primary" style={{ marginLeft: 8 }}>
                      模板
                    </Tag>
                  ) : null}
                </span>
              ),
            },
            { colKey: "host", title: "宿主", width: 160, cell: ({ row }) => hostLabel(row.host) },
            {
              colKey: "status",
              title: "状态",
              width: 100,
              cell: ({ row }) => <AgentStatusTag status={row.status} />,
            },
            {
              colKey: "last_seen_at",
              title: "最近出现",
              width: 150,
              cell: ({ row }) => formatTime(row.last_seen_at),
            },
            { colKey: "created_at", title: "创建时间", width: 150, cell: ({ row }) => formatTime(row.created_at) },
          ]}
          onRowClick={({ row }) => navigate(buildPath({ name: "agent", id: row.id }))}
        />
        </section>
      ) : null}

      <CreateAgentDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(agent) => {
          setCreating(false);
          setVersion((v) => v + 1);
          navigate(buildPath({ name: "agent", id: agent.id }));
        }}
      />
    </>
  );
}

function CreateAgentDrawer(props: { open: boolean; onClose(): void; onCreated(agent: Agent): void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [host, setHost] = useState("claude-code");
  const [description, setDescription] = useState("");
  const [isTemplate, setIsTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await app.call("agent/create", {
        team: app.currentTeam ?? undefined,
        name: name.trim(),
        host,
        description: description.trim() || undefined,
        is_template: isTemplate || undefined,
      });
      MessagePlugin.success("已创建");
      setName("");
      setDescription("");
      props.onCreated(res.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const nameOk = /^[a-z0-9][a-z0-9-]*$/.test(name.trim());

  return (
    <Drawer visible={props.open} size="480px" header="新建 Agent" footer={null} onClose={props.onClose}>
      <div className="ck-drawer-body">
        {error ? <p className="ck-login-error">{error}</p> : null}
        <label className="ck-field">
          <span className="ck-field-label">名称</span>
          <Input value={name} onChange={(value) => setName(value)} placeholder="kebab-case，如 cc-ly" />
          <span className={name.trim() && !nameOk ? "ck-error-strong" : "ck-field-hint"}>
            小写字母、数字、连字符；团队内唯一。
          </span>
        </label>
        <label className="ck-field">
          <span className="ck-field-label">宿主</span>
          <HostPicker value={host} onChange={setHost} />
        </label>
        <label className="ck-field">
          <span className="ck-field-label">描述</span>
          <Input value={description} onChange={(value) => setDescription(value)} placeholder="可选" />
        </label>
        <label className="ck-check">
          <Switch value={isTemplate} onChange={(value) => setIsTemplate(value)} />
          <span>作为团队默认模板（新 Agent 自动套用它的配装）</span>
        </label>
        <div className="ck-row-actions">
          <Button theme="primary" loading={busy} disabled={!nameOk} onClick={() => void submit()}>
            创建
          </Button>
          <Button variant="outline" onClick={props.onClose}>
            取消
          </Button>
        </div>
        <p className="ck-muted">通常不必手工建：在宿主里 ck setup 即会 agent/ensure。</p>
      </div>
    </Drawer>
  );
}
