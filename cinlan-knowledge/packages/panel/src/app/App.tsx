import { useEffect } from "react";
import { useApp, useNavigate } from "./context.js";
import { Shell } from "./Shell.js";
import { LoginPage } from "../pages/Login.js";
import { AssetsPage } from "../pages/Assets.js";
import { InboxPage } from "../pages/Inbox.js";
import { ReviewsPage } from "../pages/Reviews.js";
import { AgentsPage } from "../pages/Agents.js";
import { AgentDetailPage } from "../pages/AgentDetail.js";
import { TeamsPage } from "../pages/Teams.js";
import { TeamDetailPage } from "../pages/TeamDetail.js";
import { AccessPage } from "../pages/Access.js";
import { UsagePage } from "../pages/Usage.js";
import { AuditPage } from "../pages/Audit.js";
import { GuidePage } from "../pages/Guide.js";
import { EmptyState } from "./ui.js";

/** 顶层路由（lib/router.ts）：没有会话一律进登录页；详情页可深链。 */
export function App() {
  const app = useApp();
  const navigate = useNavigate();

  // 已登录还访问 /panel/login 时没有可展示的内容，退回 /assets。
  useEffect(() => {
    if (app.key !== null && app.verification !== null && app.route.name === "login") {
      navigate("/panel/assets");
    }
  }, [app.key, app.verification, app.route.name, navigate]);

  if (app.key === null || app.verification === null) {
    return <LoginPage />;
  }

  const route = app.route;

  return (
    <Shell>
      {route.name === "assets" && <AssetsPage />}
      {route.name === "inbox" && <InboxPage />}
      {route.name === "reviews" && <ReviewsPage />}
      {route.name === "agents" && <AgentsPage />}
      {route.name === "agent" && <AgentDetailPage key={route.id} agentId={route.id} />}
      {route.name === "teams" && <TeamsPage />}
      {route.name === "team" && <TeamDetailPage key={route.id} teamId={route.id} />}
      {route.name === "access" && <AccessPage />}
      {route.name === "usage" && <UsagePage />}
      {route.name === "audit" && <AuditPage />}
      {route.name === "guide" && <GuidePage />}
      {route.name === "login" && <AssetsPage />}
      {route.name === "notFound" && (
        <EmptyState title="页面不存在" hint="检查地址，或从左侧菜单进入。" />
      )}
    </Shell>
  );
}
