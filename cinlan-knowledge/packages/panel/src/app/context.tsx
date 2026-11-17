import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Team, Verification } from "@cinlan/knowledge-sdk";
import { ApiError, createClient, type Client } from "../lib/api.js";
import { createSession, type KeyValueStore, type Session } from "../lib/session.js";
import { buildPath, parseRoute, type Route } from "../lib/router.js";

/** 全站状态：会话、当前团队、路由。SSR 不做，直接读 window。 */
interface AppValue {
  session: Session;
  verification: Verification | null;
  currentTeam: string | null;
  /** SA 看全部团队；其他人只看自己所在的团队。 */
  teams: Team[];
  teamsError: ApiError | null;
  key: string | null;
  login(key: string): Promise<void>;
  logout(): void;
  setCurrentTeam(team: string): void;
  /** 401 后回登录页时的提示。 */
  authNotice: string | null;
  call: Client["call"];
  route: Route;
  navigate(to: string): void;
  reloadTeams(): void;
}

const Context = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(Context);
  if (!value) throw new Error("useApp 必须在 AppProvider 内使用");
  return value;
}

function browserStore(): KeyValueStore {
  return sessionStorage;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const sessionRef = useRef<Session | null>(null);
  if (sessionRef.current === null) sessionRef.current = createSession(browserStore());
  const session = sessionRef.current;

  const [verification, setVerification] = useState<Verification | null>(null);
  const [currentTeam, setTeamState] = useState<string | null>(session.currentTeam);
  const [key, setKey] = useState<string | null>(session.key);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsError, setTeamsError] = useState<ApiError | null>(null);
  const [teamsTick, setTeamsTick] = useState(0);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname + location.search));

  const client = useMemo(
    () =>
      createClient({
        baseUrl: "",
        getKey: () => session.key,
        onUnauthorized: () => {
          session.clear();
          setVerification(null);
          setKey(null);
          setTeams([]);
          setAuthNotice("登录已失效，请重新输入 key。");
        },
      }),
    [session],
  );

  // 地址栏前进后退。
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname + location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    location.assign(to);
  }, []);

  // 有 key 没验证明细（刷新页）时重取一次。
  useEffect(() => {
    if (verification !== null || key === null) return;
    let alive = true;
    client
      .call("auth/verify", {})
      .then((v) => {
        if (!alive) return;
        session.setVerification(v);
        setVerification(v);
        setTeamState(session.currentTeam);
      })
      .catch((cause) => {
        if (!alive) return;
        if (cause instanceof ApiError && cause.code === "UNAUTHORIZED") return;
        setAuthNotice(cause instanceof ApiError ? cause.detail || cause.code : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [client, key, verification, session]);

  // 团队列表：SA 取全部（分页拉完），其他人用验证明细里的成员关系。
  useEffect(() => {
    if (verification === null) {
      setTeams([]);
      return;
    }
    if (!verification.is_system_admin) {
      setTeams(
        verification.teams.map((t) => ({
          id: t.team_id,
          name: t.team,
          title: t.team,
          description: "",
          review_mode: "off",
          allow_self_approve: false,
          template_agent_id: null,
          created_at: "",
        })),
      );
      setTeamsError(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      const all: Team[] = [];
      let cursor = "";
      for (;;) {
        const page = await client.call("team/list", cursor === "" ? { limit: 100 } : { limit: 100, cursor }, {
          signal: controller.signal,
        });
        all.push(...page.items);
        if (page.next_cursor === "") break;
        cursor = page.next_cursor;
      }
      if (!alive) return;
      setTeams(all);
      setTeamsError(null);
    })().catch((cause) => {
      if (!alive || (cause instanceof Error && cause.name === "AbortError")) return;
      setTeamsError(cause instanceof ApiError ? cause : new ApiError({
        code: "BAD_RESPONSE",
        status: 0,
        requestId: "",
        detail: String(cause),
        data: {},
        retryAfter: null,
      }));
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [client, verification, teamsTick]);

  const login = useCallback(
    async (nextKey: string) => {
      const probe = createClient({ baseUrl: "", getKey: () => nextKey });
      const v = await probe.call("auth/verify", {});
      session.saveKey(nextKey);
      session.setVerification(v);
      setKey(nextKey);
      setVerification(v);
      setTeamState(session.currentTeam);
      setAuthNotice(null);
    },
    [session],
  );

  const logout = useCallback(() => {
    session.clear();
    setVerification(null);
    setKey(null);
    setTeams([]);
    setAuthNotice(null);
  }, [session]);

  const setCurrentTeam = useCallback(
    (team: string) => {
      session.setCurrentTeam(team);
      setTeamState(team);
    },
    [session],
  );

  const reloadTeams = useCallback(() => setTeamsTick((n) => n + 1), []);

  const value = useMemo<AppValue>(
    () => ({
      session,
      verification,
      currentTeam,
      teams,
      teamsError,
      key,
      login,
      logout,
      setCurrentTeam,
      authNotice,
      call: client.call,
      route,
      navigate,
      reloadTeams,
    }),
    [
      session,
      verification,
      currentTeam,
      teams,
      teamsError,
      key,
      login,
      logout,
      setCurrentTeam,
      authNotice,
      client,
      route,
      navigate,
      reloadTeams,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** 页面内跳转：用 History API，不整页刷新。 */
export function useNavigate(): (to: string) => void {
  return useCallback((to: string) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);
}

export { buildPath };
