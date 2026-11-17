import { useState } from "react";
import { Button, Select, Table, Tabs, Tag } from "tdesign-react";
import type { UsageSummary } from "@cinlan/knowledge-sdk";
import { useApp } from "../app/context.js";
import { EmptyState, ErrorBlock, LoadingState, PageHeader, useAsync, AssetStatusTag, AssetTypeTag } from "../app/ui.js";
import { formatNumber, formatTime, hostLabel } from "../lib/format.js";
import { canSeeUsage } from "../lib/roles.js";

const WINDOWS = [7, 30, 90, 180];

/** 用量（panel-design.md §4.6）：窗口 KPI + by_asset / by_agent / cold 三张表。 */
export function UsagePage() {
  const app = useApp();
  const [days, setDays] = useState(90);
  const [tab, setTab] = useState<string | number>("asset");
  const canSee = canSeeUsage(app.verification!, app.currentTeam);

  const state = useAsync(
    (signal) =>
      canSee
        ? app.call(
            "usage/summary",
            { days, ...(app.currentTeam ? { team: app.currentTeam } : {}) },
            { signal },
          )
        : Promise.resolve(null),
    [days, app.currentTeam, canSee],
  );

  if (!canSee) {
    return (
      <>
        <PageHeader title="用量" />
        <EmptyState title="当前身份看不到用量" hint="用量只对 System Admin 和团队管理员开放。" />
      </>
    );
  }

  const data: UsageSummary | null = state.data;
  const injected = data?.by_asset.reduce((n, a) => n + a.injected, 0) ?? 0;
  const opened = data?.by_asset.reduce((n, a) => n + a.opened, 0) ?? 0;
  const activeAssets = data?.by_asset.length ?? 0;

  return (
    <>
      <PageHeader
        title="用量"
        description={data ? `窗口 ${data.from} ~ ${data.to}（UTC，${data.days} 天）` : "按 UTC 天聚合"}
        actions={
          <Select
            value={String(days)}
            options={WINDOWS.map((d) => ({ label: `最近 ${d} 天`, value: String(d) }))}
            onChange={(value) => {
              if (typeof value === "string") setDays(Number(value));
            }}
            style={{ width: 140 }}
          />
        }
      />

      {state.loading ? <LoadingState /> : null}
      {state.error ? <ErrorBlock error={state.error} onRetry={state.reload} /> : null}

      {data ? (
        <>
          <div className="ck-kpis">
            <div className="ck-kpi">
              <span className="ck-kpi-label">注入次数</span>
              <strong>{formatNumber(injected)}</strong>
            </div>
            <div className="ck-kpi">
              <span className="ck-kpi-label">打开次数</span>
              <strong>{formatNumber(opened)}</strong>
            </div>
            <div className="ck-kpi">
              <span className="ck-kpi-label">有用量的资产</span>
              <strong>{formatNumber(activeAssets)}</strong>
            </div>
            <div className="ck-kpi">
              <span className="ck-kpi-label">零用量资产</span>
              <strong>{formatNumber(data.cold.length)}</strong>
            </div>
          </div>

          <Tabs value={tab} onChange={(value) => setTab(value)}>
            <Tabs.TabPanel value="asset" label={`按资产（${data.by_asset.length}）`}>
              {data.by_asset.length === 0 ? (
                <EmptyState title="窗口内没有注入记录" hint="宿主侧要上报 usage/report 才会计数。" />
              ) : (
                <section className="ck-panel">
                <Table
                  rowKey="asset_id"
                  data={[...data.by_asset].sort((a, b) => b.injected - a.injected)}
                  columns={[
                    { colKey: "title", title: "资产", ellipsis: true },
                    { colKey: "type", title: "类型", width: 90, cell: ({ row }) => <AssetTypeTag type={row.type} /> },
                    { colKey: "status", title: "状态", width: 100, cell: ({ row }) => <AssetStatusTag status={row.status} /> },
                    { colKey: "injected", title: "注入", width: 90, cell: ({ row }) => formatNumber(row.injected) },
                    { colKey: "opened", title: "打开", width: 90, cell: ({ row }) => formatNumber(row.opened) },
                    { colKey: "owner_user_id", title: "拥有者", width: 180, cell: ({ row }) => row.owner_user_id },
                  ]}
                />
                </section>
              )}
            </Tabs.TabPanel>
            <Tabs.TabPanel value="agent" label={`按 Agent（${data.by_agent.length}）`}>
              {data.by_agent.length === 0 ? (
                <EmptyState title="窗口内没有 Agent 上报" />
              ) : (
                <section className="ck-panel">
                <Table
                  rowKey="agent_id"
                  data={[...data.by_agent].sort((a, b) => b.injected - a.injected)}
                  columns={[
                    { colKey: "name", title: "Agent" },
                    { colKey: "host", title: "宿主", width: 160, cell: ({ row }) => hostLabel(row.host) },
                    { colKey: "injected", title: "注入", width: 90, cell: ({ row }) => formatNumber(row.injected) },
                    { colKey: "opened", title: "打开", width: 90, cell: ({ row }) => formatNumber(row.opened) },
                    { colKey: "owner_user_id", title: "拥有者", width: 180, cell: ({ row }) => row.owner_user_id },
                  ]}
                />
                </section>
              )}
            </Tabs.TabPanel>
            <Tabs.TabPanel value="cold" label={`零用量（${data.cold.length}）`}>
              <p className="ck-muted">窗口内零注入的团队资产；治理入口（SOP B.6）。</p>
              {data.cold.length === 0 ? (
                <EmptyState title="没有零用量资产" />
              ) : (
                <section className="ck-panel">
                <Table
                  rowKey="asset_id"
                  data={data.cold}
                  columns={[
                    { colKey: "title", title: "资产", ellipsis: true },
                    { colKey: "type", title: "类型", width: 90, cell: ({ row }) => <AssetTypeTag type={row.type} /> },
                    { colKey: "status", title: "状态", width: 100, cell: ({ row }) => <AssetStatusTag status={row.status} /> },
                    {
                      colKey: "visibility",
                      title: "可见性",
                      width: 90,
                      cell: ({ row }) => <Tag variant="light">{row.visibility}</Tag>,
                    },
                    { colKey: "updated_at", title: "更新时间", width: 150, cell: ({ row }) => formatTime(row.updated_at) },
                  ]}
                />
                </section>
              )}
            </Tabs.TabPanel>
          </Tabs>
        </>
      ) : null}
    </>
  );
}
