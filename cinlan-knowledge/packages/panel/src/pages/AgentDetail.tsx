import { useEffect, useState } from "react";
import { Button, Input, Select, Table, Tag, MessagePlugin, Popconfirm } from "tdesign-react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DeleteIcon,
  RefreshIcon,
  SwapIcon,
} from "tdesign-icons-react";
import type { Agent, Asset, InjectionMode, LoadoutBinding } from "@cinlan/knowledge-sdk";
import { useApp, useNavigate } from "../app/context.js";
import {
  AgentStatusTag,
  EmptyState,
  ErrorBlock,
  InjectionModeTag,
  KV,
  LoadingState,
  PageHeader,
  SkipReasonTag,
  useAsync,
  toApiError,
} from "../app/ui.js";
import { formatBytes, formatNumber, formatTime, hostLabel } from "../lib/format.js";
import { buildPath, BASE } from "../lib/router.js";
import { canManageTeam } from "../lib/roles.js";
import {
  addBinding,
  BUDGET_PRESETS,
  BUDGET_PRESET_LABEL,
  isDirty,
  move,
  removeBinding,
  sortByPriority,
  toSetRequest,
  updateBinding,
  type Budget,
  type BudgetPreset,
  type DraftBinding,
} from "../lib/loadout.js";
import { ApiError } from "../lib/api.js";

type Row = LoadoutBinding & { asset: Asset | null; available: boolean };

/** Agent 详情（panel-design.md §4.3）：配装表 + 预算预览；深链 /panel/agents/:id。 */
export function AgentDetailPage({ agentId }: { agentId: string }) {
  const app = useApp();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<DraftBinding[] | null>(null);
  const [saved, setSaved] = useState<DraftBinding[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [preset, setPreset] = useState<BudgetPreset | "brief">("full");
  const [version, setVersion] = useState(0);

  const state = useAsync(
    (signal) =>
      Promise.all([
        app.call("agent/get", { agent_id: agentId }, { signal }),
        app.call("loadout/get", { agent_id: agentId }, { signal }),
      ]),
    [agentId, version],
  );

  const agent: Agent | null = state.data?.[0]?.agent ?? null;
  const bindings = state.data?.[1]?.bindings ?? null;

  useEffect(() => {
    if (bindings === null) return;
    setRows(bindings as Row[]);
    const initial = sortByPriority(
      bindings.map((b) => ({
        asset_id: b.asset_id,
        priority: b.priority,
        injection_mode: b.injection_mode,
        pin_version: b.pin_version,
      })),
    );
    setDraft(initial);
    setSaved(initial);
  }, [bindings]);

  const dirty = draft !== null && isDirty(draft, saved);
  const canManage = canManageTeam(app.verification!, app.currentTeam);
  const agentTeamName = app.teams.find((t) => t.id === agent?.team_id)?.name ?? null;

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await app.call("loadout/set", toSetRequest(agentId, draft));
      MessagePlugin.success("配装已保存");
      setVersion((v) => v + 1);
    } catch (cause) {
      setSaveError(toApiError(cause));
    } finally {
      setSaving(false);
    }
  };

  const syncTemplate = async (mode: "add-missing" | "replace") => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await app.call("loadout/sync-template", { agent_id: agentId, mode });
      MessagePlugin.success(`模板已同步：新增 ${res.applied} 条，移除 ${res.removed} 条`);
      setVersion((v) => v + 1);
    } catch (cause) {
      setSaveError(toApiError(cause));
    } finally {
      setSaving(false);
    }
  };

  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorBlock error={state.error} onRetry={state.reload} />;
  if (!agent) return <ErrorBlock error={toApiError(new Error("agent 不存在"))} />;

  const assetTitle = new Map(rows.map((r) => [r.asset_id, r.asset?.title ?? r.asset_id]));

  return (
    <>
      <PageHeader
        title={`${agent.name}${agent.is_template ? " · 模板" : ""}`}
        description={
          <>
            {hostLabel(agent.host)} · {agent.team_id}
            {agent.status === "archived" ? (
              <Tag variant="light" theme="default" style={{ marginLeft: 8 }}>
                已归档
              </Tag>
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" icon={<RefreshIcon />} onClick={() => setVersion((v) => v + 1)}>
              刷新
            </Button>
            <Button variant="text" onClick={() => navigate(`${BASE}/agents`)}>
              返回列表
            </Button>
          </>
        }
      />

      <div className="ck-detail-grid">
        <section className="ck-panel">
          <div className="ck-panel-head">
            <h2 className="ck-panel-title">配装表</h2>
            <div className="ck-row-actions">
              {dirty ? (
                <>
                  <Button variant="outline" disabled={saving} onClick={() => setDraft(saved)}>
                    放弃改动
                  </Button>
                  <Button theme="primary" loading={saving} onClick={() => void save()}>
                    保存配装
                  </Button>
                </>
              ) : (
                <span className="ck-muted">无未保存改动</span>
              )}
            </div>
          </div>
          {saveError ? <ErrorBlock error={saveError} /> : null}

          {draft === null || draft.length === 0 ? (
            <EmptyState
              title="还没有绑定资产"
              hint="从下面「添加资产」挑一条；顺序即注入顺序。"
            />
          ) : (
            <table className="ck-loadout" aria-label="配装表">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 56 }}>
                    顺序
                  </th>
                  <th scope="col">资产</th>
                  <th scope="col" style={{ width: 120 }}>
                    送法
                  </th>
                  <th scope="col" style={{ width: 120 }}>
                    固定版本
                  </th>
                  <th scope="col" style={{ width: 64 }}>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.map((b, index) => {
                  const row = rows.find((r) => r.asset_id === b.asset_id);
                  return (
                    <tr key={b.asset_id}>
                      <td>
                        <div className="ck-order">
                          <Button
                            variant="text"
                            size="small"
                            disabled={index === 0}
                            aria-label="上移"
                            icon={<ChevronUpIcon />}
                            onClick={() => setDraft((d) => (d ? move(d, b.asset_id, "up") : d))}
                          />
                          <Button
                            variant="text"
                            size="small"
                            disabled={index === draft.length - 1}
                            aria-label="下移"
                            icon={<ChevronDownIcon />}
                            onClick={() => setDraft((d) => (d ? move(d, b.asset_id, "down") : d))}
                          />
                        </div>
                      </td>
                      <td>
                        <div className="ck-loadout-title">
                          {assetTitle.get(b.asset_id) ?? b.asset_id}
                          {row && !row.available ? (
                            <Tag variant="light" theme="warning">
                              不可用
                            </Tag>
                          ) : null}
                          {row?.source === "template" ? <Tag variant="outline">模板</Tag> : null}
                        </div>
                        <span className="ck-muted ck-small">{b.asset_id}</span>
                      </td>
                      <td>
                        <Select
                          size="small"
                          value={b.injection_mode}
                          options={[
                            { label: "注入", value: "inject" },
                            { label: "工具", value: "tool" },
                          ]}
                          onChange={(value) =>
                            setDraft((d) =>
                              d ? updateBinding(d, b.asset_id, { injection_mode: value as InjectionMode }) : d,
                            )
                          }
                        />
                      </td>
                      <td>
                        <Input
                          size="small"
                          value={b.pin_version === null ? "" : String(b.pin_version)}
                          placeholder="跟随最新"
                          onChange={(value) => {
                            const trimmed = value.trim();
                            const next = trimmed === "" ? null : Number(trimmed);
                            if (next !== null && (!Number.isInteger(next) || next <= 0)) return;
                            setDraft((d) => (d ? updateBinding(d, b.asset_id, { pin_version: next }) : d));
                          }}
                        />
                      </td>
                      <td>
                        <Button
                          variant="text"
                          size="small"
                          aria-label="移除"
                          icon={<DeleteIcon />}
                          onClick={() => setDraft((d) => (d ? removeBinding(d, b.asset_id) : d))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <AddAsset draft={draft} onAdd={(binding) => setDraft((d) => (d ? addBinding(d, binding) : d))} />

          {canManage ? (
            <div className="ck-section">
              <h3 className="ck-section-title">模板下发</h3>
              <p className="ck-muted">把团队的默认模板配装同步到这个 Agent；手工添加的绑定不会被 replace 删掉。</p>
              <div className="ck-row-actions">
                <Popconfirm
                  content="只补这个 Agent 没有的绑定（add-missing），不影响现有行。继续？"
                  onConfirm={() => void syncTemplate("add-missing")}
                >
                  <Button variant="outline" loading={saving}>
                    同步模板（补齐）
                  </Button>
                </Popconfirm>
                <Popconfirm
                  content="先删掉这个 Agent 上来源为模板的绑定，再整份拷贝（replace）。手工绑定保留。继续？"
                  onConfirm={() => void syncTemplate("replace")}
                >
                  <Button variant="outline" loading={saving}>
                    同步模板（整份替换）
                  </Button>
                </Popconfirm>
              </div>
            </div>
          ) : null}
        </section>

        <aside className="ck-panel">
          <h2 className="ck-panel-title">Agent 信息</h2>
          <KV label="宿主">{hostLabel(agent.host)}</KV>
          <KV label="拥有者">{agent.owner_user_id}</KV>
          <KV label="最近出现">{formatTime(agent.last_seen_at)}</KV>
          <KV label="创建时间">{formatTime(agent.created_at)}</KV>
          <KV label="状态">
            <AgentStatusTag status={agent.status} />
          </KV>
          <KV label="深链">{buildPath({ name: "agent", id: agent.id })}</KV>

          <TemplatePanel agent={agent} team={agentTeamName} onChanged={() => setVersion((v) => v + 1)} />

          {agent.status !== "archived" ? (
            <div className="ck-section">
              <h3 className="ck-section-title">归档</h3>
              <Popconfirm content="归档后不再参与配装解析，可稍后恢复（重新 ensure）。继续？" onConfirm={() => void archive()}>
                <Button variant="outline" theme="danger" loading={saving}>
                  归档这个 Agent
                </Button>
              </Popconfirm>
            </div>
          ) : null}

          <ResolvePreview agentId={agent.id} preset={preset} onPreset={setPreset} draft={draft} />
        </aside>
      </div>
    </>
  );

  async function archive() {
    setSaving(true);
    setSaveError(null);
    try {
      await app.call("agent/archive", { agent_id: agent!.id });
      MessagePlugin.success("已归档");
      setVersion((v) => v + 1);
    } catch (cause) {
      setSaveError(toApiError(cause));
    } finally {
      setSaving(false);
    }
  }
}

function AddAsset(props: {
  draft: DraftBinding[] | null;
  onAdd(binding: Pick<DraftBinding, "asset_id" | "injection_mode" | "pin_version">): void;
}) {
  const app = useApp();
  const [picked, setPicked] = useState<string | null>(null);
  const state = useAsync(
    (signal) =>
      app.currentTeam
        ? app.call("asset/list", { team: app.currentTeam, limit: 100, status: "active" }, { signal })
        : Promise.resolve({ items: [] as Asset[], next_cursor: "" }),
    [app.currentTeam],
  );

  const bound = new Set((props.draft ?? []).map((b) => b.asset_id));
  const options = (state.data?.items ?? [])
    .filter((a) => !bound.has(a.id))
    .map((a) => ({ label: `${a.title}（${a.type}）`, value: a.id }));

  return (
    <div className="ck-section">
      <h3 className="ck-section-title">添加资产</h3>
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      <div className="ck-row-actions">
        <Select
          value={picked ?? undefined}
          options={options}
          placeholder={options.length === 0 ? "没有可加的有效资产" : "选一条资产"}
          filterable
          clearable
          loading={state.loading}
          onChange={(value) => setPicked(typeof value === "string" ? value : null)}
          style={{ flex: 1, minWidth: 260 }}
        />
        <Button
          variant="outline"
          icon={<SwapIcon />}
          disabled={picked === null}
          onClick={() => {
            if (picked === null) return;
            props.onAdd({ asset_id: picked, injection_mode: "inject", pin_version: null });
            setPicked(null);
          }}
        >
          加入
        </Button>
      </div>
      <p className="ck-muted">只列本团队生效中的资产；共享审批中的条目要等通过后才能绑定。</p>
    </div>
  );
}

function TemplatePanel(props: { agent: Agent; team: string | null; onChanged(): void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const canManage = canManageTeam(app.verification!, props.team ?? app.currentTeam);

  const setDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.call("agent/set-default-template", { team: props.team ?? app.currentTeam ?? undefined, agent_id: props.agent.id });
      MessagePlugin.success("已设为团队默认模板");
      props.onChanged();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleTemplate = async (value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await app.call("agent/update", { agent_id: props.agent.id, is_template: value });
      props.onChanged();
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ck-section">
      <h3 className="ck-section-title">模板</h3>
      {error ? <ErrorBlock error={error} /> : null}
      {props.agent.is_template ? <p className="ck-muted">当前是模板 Agent：新 Agent 的配装从这里拷贝。</p> : (
        <p className="ck-muted">模板 Agent 的配装会被新 Agent 自动套用。</p>
      )}
      <div className="ck-row-actions">
        <Button variant="outline" loading={busy} onClick={() => void toggleTemplate(!props.agent.is_template)}>
          {props.agent.is_template ? "取消模板标记" : "标记为模板"}
        </Button>
        {props.agent.is_template && canManage ? (
          <Button theme="primary" variant="outline" loading={busy} onClick={() => void setDefault()}>
            设为团队默认
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ResolvePreview(props: {
  agentId: string;
  preset: BudgetPreset;
  onPreset(preset: BudgetPreset): void;
  draft: DraftBinding[] | null;
}) {
  const app = useApp();
  const budget: Budget = BUDGET_PRESETS[props.preset];
  const state = useAsync(
    (signal) =>
      app.call(
        "loadout/resolve",
        props.preset === "brief"
          ? { agent_id: props.agentId, budget_chars: 1500 }
          : { agent_id: props.agentId, budget_chars: budget.budget_chars, max_bytes: budget.max_bytes },
        { signal },
      ),
    [props.agentId, props.preset],
  );

  const result = state.data;
  const overflow = result ? result.chars > budget.budget_chars : false;

  return (
    <div className="ck-section">
      <h3 className="ck-section-title">预算预览</h3>
      <p className="ck-muted">
        这是 hub 按已保存配装算出来的结果；改了配装先保存再看。预算只是预览，不是硬限制。
      </p>
      <Select
        size="small"
        value={props.preset}
        options={(Object.keys(BUDGET_PRESETS) as BudgetPreset[]).map((k) => ({
          label: `${BUDGET_PRESET_LABEL[k]} · ${formatNumber(BUDGET_PRESETS[k].budget_chars)} 字`,
          value: k,
        }))}
        onChange={(value) => {
          if (typeof value === "string") props.onPreset(value as BudgetPreset);
        }}
        style={{ width: "100%" }}
      />
      {state.loading ? <LoadingState text="计算中…" /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}
      {result ? (
        <>
          <div className="ck-kpis ck-kpis-compact">
            <div className="ck-kpi">
              <span className="ck-kpi-label">字符</span>
              <strong className={overflow ? "ck-error-strong" : undefined}>{formatNumber(result.chars)}</strong>
              <span className="ck-muted"> / {formatNumber(budget.budget_chars)}</span>
            </div>
            <div className="ck-kpi">
              <span className="ck-kpi-label">字节</span>
              <strong>{formatBytes(result.bytes)}</strong>
            </div>
            <div className="ck-kpi">
              <span className="ck-kpi-label">条目</span>
              <strong>{result.items.length}</strong>
            </div>
            <div className="ck-kpi">
              <span className="ck-kpi-label">降级</span>
              <strong>{result.downgraded}</strong>
            </div>
          </div>
          {overflow ? (
            <p className="ck-error-strong">超出该送法的预算 {formatNumber(result.chars - budget.budget_chars)} 字，宿主侧会被截断。</p>
          ) : null}
          {result.skipped.length > 0 ? (
            <>
              <h4 className="ck-subtitle">被跳过</h4>
              <ul className="ck-skipped">
                {result.skipped.map((s, i) => (
                  <li key={`${s.asset_id}-${i}`}>
                    <span className="ck-muted">{s.asset_id}</span> <SkipReasonTag reason={s.reason} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {result.skills.length > 0 ? (
            <>
              <h4 className="ck-subtitle">技能</h4>
              <p className="ck-small">{result.skills.map((s) => s.name).join("、")}</p>
            </>
          ) : null}
          <section className="ck-panel">
          <Table
            rowKey="asset_id"
            data={result.items}
            columns={[
              { colKey: "title", title: "条目", ellipsis: true },
              { colKey: "mode", title: "送法", width: 80, cell: ({ row }) => <InjectionModeTag mode={row.mode} /> },
              { colKey: "chars", title: "字符", width: 80, cell: ({ row }) => formatNumber(row.chars) },
            ]}
          />
          </section>
          <p className="ck-muted ck-small">
            生成于 {formatTime(result.generated_at)} · digest {result.digest.slice(0, 12)}…
            {result.not_modified ? " · 未变化" : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}
