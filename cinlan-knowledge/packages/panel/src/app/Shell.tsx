import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Button, Dropdown, Menu, Select, Tag } from "tdesign-react";
import {
  AppIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChartIcon,
  FileIcon,
  KeyIcon,
  MailIcon,
  RootListIcon,
  ServerIcon,
  UserCircleIcon,
  UserSafetyIcon,
} from "tdesign-icons-react";
import { useApp, useNavigate } from "./context.js";
import { menuFor, canManageTeam, type MenuGroup } from "../lib/roles.js";

const GROUP_ORDER: MenuGroup[] = ["资产管理", "治理", "配装与组织"];

const ICONS: Record<string, ReactElement> = {
  "/assets": <FileIcon />,
  "/inbox": <MailIcon />,
  "/reviews": <CheckCircleIcon />,
  "/usage": <ChartIcon />,
  "/audit": <RootListIcon />,
  "/agents": <AppIcon />,
  "/teams": <UserSafetyIcon />,
  "/access": <KeyIcon />,
};

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  /* ≤900px 媒体查询把侧栏压成 56px 图标列；Menu 必须跟着真收起，否则展开态菜单项在窄栏里溢出被裁。 */
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const folded = collapsed || narrow;
  const v = app.verification;
  if (!v) return null;

  const items = menuFor(v);
  const activeMenu = app.route.name === "notFound" ? "" : `/${app.route.name}`;
  const teamAdmin = canManageTeam(v, app.currentTeam);

  // 收件箱徽标：当前团队 + draft 状态 + 我的草稿（权限过滤在 asset/list 的 draft 谓词）
  const inboxCount = useInboxCount(app.currentTeam);

  // 侧边导航布局 + 平铺式侧边导航（参考腾讯 Memory Hub 左侧面板）：
  // 侧栏顶部 = 团队切换（品牌色块 + 名称 + slug 下拉），导航 = 平铺列表（不嵌套分组）
  const currentTeam = app.teams.find((t) => t.name === app.currentTeam) ?? null;

  return (
    <div className="ck-shell">
      <header className="ck-topbar">
        <div className="ck-brand">
          <ServerIcon size="20px" />
          <span>Cinlan Knowledge</span>
        </div>
        <div className="ck-topbar-center" />
        <div className="ck-topbar-right">
          {inboxCount > 0 ? (
            <Button variant="text" icon={<MailIcon />} onClick={() => navigate("/panel/inbox")} style={{ position: "relative" }}>
              <span className="ck-inbox-badge">{inboxCount}</span>
            </Button>
          ) : null}
          <Button variant="text" icon={<BookOpenIcon />} onClick={() => navigate("/panel/guide")}>
            接入指南
          </Button>
          <Dropdown
            options={[
              { content: "我的 key", value: "access" },
              { content: "退出登录", value: "logout" },
            ]}
            onClick={(data) => {
              if (data.value === "access") navigate("/panel/access");
              else app.logout();
            }}
          >
            <Button variant="text" icon={<UserCircleIcon />}>
              {v.user.display_name}
            </Button>
          </Dropdown>
        </div>
      </header>
      <div className="ck-body">
        <aside className={folded ? "ck-sider ck-sider-collapsed" : "ck-sider"}>
          {/* 侧栏顶部：团队标识/切换（品牌色块 + 名称 + slug 下拉）。单团队显示标识（不可切换），多团队可切换。 */}
          {!folded && currentTeam ? (
            <div className="ck-team-switcher">
              <div className="ck-team-badge">
                <span className="ck-team-badge-letter">{(currentTeam.title || currentTeam.name)[0]?.toUpperCase() ?? "?"}</span>
              </div>
              {app.teams.length > 1 ? (
                <Select
                  value={app.currentTeam ?? undefined}
                  filterable={false}
                  options={app.teams.map((t) => ({ label: `${t.title || t.name} · ${t.name}`, value: t.name }))}
                  onChange={(value) => {
                    if (typeof value === "string") app.setCurrentTeam(value);
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                  size="small"
                />
              ) : (
                <div className="ck-team-name">
                  <span className="ck-team-title">{currentTeam.title || currentTeam.name}</span>
                  <span className="ck-team-slug">{currentTeam.name}</span>
                </div>
              )}
            </div>
          ) : null}
          <div className="ck-sider-head">
            {/* 窄屏下侧栏自动收起，手动开关没有意义，藏掉。 */}
            {!narrow ? (
              <Button
                variant="text"
                size="small"
                icon={folded ? <ChevronRightIcon /> : <ChevronLeftIcon />}
                onClick={() => setCollapsed((c) => !c)}
              >
                {folded ? "" : "收起"}
              </Button>
            ) : null}
          </div>
          {/* 平铺式侧边导航：不嵌套分组，全部平铺；上组「工作台」与下组「组织」用间距分隔 */}
          <Menu
            theme="light"
            value={activeMenu}
            collapsed={folded}
            width={[240, 56]}
            onChange={(value) => {
              if (typeof value === "string") navigate(navigatePath(value));
            }}
          >
            {items.map((item, index) => {
              // 第一组与第二组之间加分隔（平铺式侧边导航：组间用间距而非嵌套标题）
              const isSecondGroup = index > 0 && items[index - 1]!.group !== item.group;
              return (
                <Menu.MenuItem
                  key={item.path}
                  value={item.path}
                  icon={ICONS[item.path]}
                  content={item.label}
                  className={isSecondGroup ? "ck-menu-divider" : undefined}
                />
              );
            })}
          </Menu>
          {teamAdmin && app.currentTeam ? (
            <div className="ck-sider-foot">
              <Tag variant="light">团队管理员</Tag>
            </div>
          ) : null}
        </aside>
        <main className="ck-main">
          <div className="ck-main-inner">{children}</div>
        </main>
      </div>
    </div>
  );
}

function navigatePath(menuPath: string): string {
  return `/panel${menuPath}`;
}

/** 收件箱草稿计数（当前团队 + draft + 我的）。无 team 或无权限时 0。 */
function useInboxCount(team: string | null): number {
  const app = useApp();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (team === null) {
      setCount(0);
      return;
    }
    let alive = true;
    app
      .call("asset/list", { team, status: "draft", limit: 100 })
      .then((page) => {
        if (alive) setCount(page.items.length);
      })
      .catch(() => {
        // 草稿读取失败不拦主流程
        if (alive) setCount(0);
      });
    return () => {
      alive = false;
    };
  }, [app, team]);
  return count;
}
