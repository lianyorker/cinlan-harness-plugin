import { useState } from "react";
import { Button, Input, Select, Table, Tag, MessagePlugin, Popconfirm } from "tdesign-react";
import type { Team, TeamMember, TeamRole } from "@cinlan/knowledge-sdk";
import { useApp, useNavigate } from "../app/context.js";
import {
  EmptyState,
  ErrorBlock,
  KV,
  LoadingState,
  PageHeader,
  useAsync,
  toApiError,
} from "../app/ui.js";
import { formatTime, hostLabel } from "../lib/format.js";
import { BASE, buildPath } from "../lib/router.js";
import { canManageTeam } from "../lib/roles.js";
import { ApiError } from "../lib/api.js";

const REVIEW_MODE_OPTIONS = [
  { label: "免审（off）", value: "off" },
  { label: "共享需审批（share）", value: "share" },
  { label: "全部需审批（all）", value: "all" },
];

/** 团队详情（panel-design.md §4.4）：成员与角色、审批策略、默认模板；深链 /panel/teams/:id。 */
export function TeamDetailPage({ teamId }: { teamId: string }) {
  const app = useApp();
  const navigate = useNavigate();
  const [version, setVersion] = useState(0);

  const state = useAsync(
    (signal) =>
      Promise.all([
        app.call("team/get", { team_id: teamId }, { signal }),
        app.call("team-member/list", { team_id: teamId }, { signal }),
        app.call("agent/get-default-template", { team_id: teamId }, { signal }),
      ]),
    [teamId, version],
  );

  const team: Team | null = state.data?.[0]?.team ?? null;
  const members: TeamMember[] = state.data?.[1]?.members ?? [];
  const template = state.data?.[2]?.agent ?? null;
  const canManage = canManageTeam(app.verification!, team?.name ?? null);
  const reload = () => setVersion((v) => v + 1);

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorBlock error={state.error} onRetry={state.reload} />;
  if (!team) return <EmptyState title="团队不存在或无权查看" />;

  return (
    <>
      <PageHeader
        title={team.title}
        description={<span className="ck-muted">{team.name} · 创建于 {formatTime(team.created_at)}</span>}
        actions={
          <Button variant="text" onClick={() => navigate(`${BASE}/teams`)}>
            返回列表
          </Button>
        }
      />

      <div className="ck-detail-grid">
        <section className="ck-panel">
          <h2 className="ck-panel-title">成员</h2>
          {canManage ? <AddMember teamId={team.id} onDone={reload} /> : null}
          {members.length === 0 ? (
            <EmptyState title="还没有成员" hint={canManage ? "用上面的表单加人。" : "请团队管理员添加成员。"} />
          ) : (
            <Table
              rowKey="user_id"
              data={members}
              columns={[
                {
                  colKey: "display_name",
                  title: "成员",
                  cell: ({ row }) => (
                    <span>
                      {row.display_name} <span className="ck-muted">· {row.user_name}</span>
                    </span>
                  ),
                },
                {
                  colKey: "role",
                  title: "角色",
                  width: 140,
                  cell: ({ row }) =>
                    canManage ? (
                      <Select
                        size="small"
                        value={row.role}
                        options={[
                          { label: "成员", value: "member" },
                          { label: "管理员", value: "admin" },
                        ]}
                        onChange={(value) => {
                          if (typeof value !== "string") return;
                          void setRole(team.id, row, value as TeamRole);
                        }}
                      />
                    ) : (
                      <Tag variant="light">{row.role === "admin" ? "管理员" : "成员"}</Tag>
                    ),
                },
                { colKey: "joined_at", title: "加入时间", width: 150, cell: ({ row }) => formatTime(row.joined_at) },
                {
                  colKey: "ops",
                  title: "",
                  width: 80,
                  cell: ({ row }) =>
                    canManage ? (
                      <Popconfirm
                        content={`把 ${row.user_name} 移出 ${team.name}？`}
                        onConfirm={() => void removeMember(team.id, row)}
                      >
                        <Button variant="text" size="small" theme="danger">
                          移除
                        </Button>
                      </Popconfirm>
                    ) : null,
                },
              ]}
            />
          )}
        </section>

        <aside className="ck-panel">
          <h2 className="ck-panel-title">策略</h2>
          {canManage ? (
            <PolicyForm team={team} onDone={reload} />
          ) : (
            <>
              <KV label="审批策略">{team.review_mode === "off" ? "免审" : team.review_mode === "share" ? "共享需审批" : "全部需审批"}</KV>
              <KV label="自审">团队管理员可审自己的申请：{team.allow_self_approve ? "是" : "否"}</KV>
            </>
          )}

          <div className="ck-section">
            <h3 className="ck-section-title">默认模板</h3>
            {template ? (
              <>
                <KV label="模板 Agent">
                  <Button variant="text" size="small" onClick={() => navigate(buildPath({ name: "agent", id: template.id }))}>
                    {template.name}
                  </Button>
                  <span className="ck-muted"> · {hostLabel(template.host)}</span>
                </KV>
                {canManage ? <SyncTemplateButton teamId={team.id} onDone={reload} /> : null}
              </>
            ) : (
              <p className="ck-muted">未设默认模板。到某个 Agent 详情页点「设为团队默认」。</p>
            )}
          </div>

          {app.verification?.is_system_admin ? (
            <div className="ck-section">
              <h3 className="ck-section-title">危险操作</h3>
              <Popconfirm content="删除团队会连同成员关系一起移除；资产与 Agent 需先自行清理。确认？" onConfirm={() => void deleteTeam()}>
                <Button variant="outline" theme="danger">
                  删除团队
                </Button>
              </Popconfirm>
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );

  async function setRole(id: string, row: TeamMember, role: TeamRole) {
    try {
      await app.call("team-member/set-role", { team_id: id, user_id: row.user_id, role });
      MessagePlugin.success(`${row.user_name} 的角色已改为 ${role === "admin" ? "管理员" : "成员"}`);
      reload();
    } catch (cause) {
      MessagePlugin.error(toApiError(cause).detail || describe(toApiError(cause)));
    }
  }

  async function removeMember(id: string, row: TeamMember) {
    try {
      await app.call("team-member/remove", { team_id: id, user_id: row.user_id });
      MessagePlugin.success("已移除");
      reload();
    } catch (cause) {
      MessagePlugin.error(describe(toApiError(cause)));
    }
  }

  async function deleteTeam() {
    try {
      await app.call("team/delete", { team_id: team!.id });
      MessagePlugin.success("团队已删除");
      app.reloadTeams();
      navigate(`${BASE}/teams`);
    } catch (cause) {
      MessagePlugin.error(describe(toApiError(cause)));
    }
  }
}

function describe(error: ApiError): string {
  return error.detail || error.code;
}

function AddMember(props: { teamId: string; onDone(): void }) {
  const app = useApp();
  const [user, setUser] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.call("team-member/add", { team_id: props.teamId, user: user.trim(), role });
      MessagePlugin.success("已加入");
      setUser("");
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
        <Input value={user} onChange={(value) => setUser(value)} placeholder="对方的 user slug" style={{ flex: 1 }} />
        <Select
          value={role}
          options={[
            { label: "成员", value: "member" },
            { label: "管理员", value: "admin" },
          ]}
          onChange={(value) => {
            if (typeof value === "string") setRole(value as TeamRole);
          }}
          style={{ width: 140 }}
        />
        <Button variant="outline" loading={busy} disabled={user.trim() === ""} onClick={() => void submit()}>
          添加
        </Button>
      </div>
      <p className="ck-muted">先由 System Admin 在「访问控制」创建用户，再把 slug 加进来。</p>
    </div>
  );
}

function PolicyForm(props: { team: Team; onDone(): void }) {
  const app = useApp();
  const [reviewMode, setReviewMode] = useState(props.team.review_mode);
  const [selfApprove, setSelfApprove] = useState(props.team.allow_self_approve);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const dirty = reviewMode !== props.team.review_mode || selfApprove !== props.team.allow_self_approve;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.call("team/update", {
        team_id: props.team.id,
        review_mode: reviewMode,
        allow_self_approve: selfApprove,
      });
      MessagePlugin.success("策略已更新");
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
      <label className="ck-field">
        <span className="ck-field-label">审批策略</span>
        <Select value={reviewMode} options={REVIEW_MODE_OPTIONS} onChange={(value) => setReviewMode(value as Team["review_mode"])} />
      </label>
      <label className="ck-check">
        <input type="checkbox" checked={selfApprove} onChange={(e) => setSelfApprove(e.target.checked)} />
        <span>团队管理员可以审批自己发起的申请</span>
      </label>
      <div className="ck-row-actions">
        <Button theme="primary" variant="outline" loading={busy} disabled={!dirty} onClick={() => void save()}>
          保存策略
        </Button>
      </div>
    </div>
  );
}

function SyncTemplateButton(props: { teamId: string; onDone(): void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const sync = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await app.call("agent/list", { team_id: props.teamId, limit: 100 });
      let applied = 0;
      let removed = 0;
      for (const agent of list.items) {
        if (agent.is_template || agent.status !== "active") continue;
        const res = await app.call("loadout/sync-template", { agent_id: agent.id, mode: "add-missing" });
        applied += res.applied;
        removed += res.removed;
      }
      MessagePlugin.success(`模板已同步到团队 Agent：新增 ${applied} 条绑定`);
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
      <Popconfirm content="把默认模板的绑定补到本团队所有在用 Agent（只补缺，不动手工绑定）。继续？" onConfirm={() => void sync()}>
        <Button variant="outline" loading={busy}>
          同步到团队全部 Agent
        </Button>
      </Popconfirm>
      <p className="ck-muted">逐个 Agent 走 loadout/sync-template（add-missing），串行执行。</p>
    </div>
  );
}
