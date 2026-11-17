import { materializeSkills, type MaterializeResult } from "./skills.js";
import { httpSkillSource } from "./source.js";
import { PrepareError, prepare, type AgentSpec, type PreparedLoadout } from "./prepare.js";
import type { ResolvedConfig } from "./config.js";
import { expandHome } from "./paths.js";
import type { HostConfig } from "./hosts.js";

/**
 * skill 物化入口（loadout.md §6 步骤 5、§7）：`ck mcp` 后台跑 syncSkills，`ck skills sync` 前台跑 runSkillsSync。
 * 物化另计 10 秒，超时不影响文本投递，下次启动续做；
 * 超时视为本次失败并报 `UNAVAILABLE`，不假装成功。
 */

export const SYNC_TIMEOUT_MS = 10_000;

export interface SyncOptions {
  config: ResolvedConfig;
  host: HostConfig;
  agentId: string;
  skills: PreparedLoadout["skills"];
  /** `skill_dir` 里 `~` 的展开根，即用户 home；缺省 os.homedir()。不是 ck 状态目录（CK_HOME）。 */
  home?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PrepareError("UNAVAILABLE", `skill materialization timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function syncSkills(options: SyncOptions): Promise<MaterializeResult> {
  if (!options.config.hub) throw new PrepareError("UNAVAILABLE", "hub url not configured: set CK_HUB_URL or run `ck login --hub <url>`");
  if (!options.config.key) throw new PrepareError("UNAUTHORIZED", "user key not configured: set CK_USER_KEY or run `ck login --hub <url>`");
  const source = httpSkillSource({
    hub: options.config.hub,
    key: options.config.key,
    timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });
  return withTimeout(
    materializeSkills({
      skillRoot: expandHome(options.host.skill_dir, options.home),
      agentId: options.agentId,
      skills: options.skills,
      source,
    }),
    options.timeoutMs ?? SYNC_TIMEOUT_MS,
  );
}

export interface SkillsSyncOptions {
  config: ResolvedConfig;
  host: HostConfig;
  agent: AgentSpec;
  /**
   * 覆盖用：同时充当 ck 状态目录与宿主路径里 `~` 的展开根。
   * 缺省时两者各取各的：状态目录 ckHome()，`~` 是 os.homedir()。
   */
  home?: string;
  /** 解析（agent/ensure + loadout/resolve）的时限；物化另计 SYNC_TIMEOUT_MS。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * `ck skills sync`：现取清单再物化；失败抛 PrepareError。
 * 清单永远来自本次 `loadout/resolve`，不走自动路径的那几条近路：
 * - 不看宿主的 `instructions` 形态：brief 宿主的 `prepare()` 不解析，只回缓存里的清单，没有缓存就是空清单；
 * - 不带 `if_digest`：digest 只覆盖配装文本，而 skill 行是 name + summary，
 *   skill 出了新版、摘要没变时 hub 回 `not_modified`，缓存里的旧版本号会被当成现状；
 * - hub 不可达就报错，不拿缓存里的清单冒充现状。
 * 预算取该宿主完整投递那一路的（`instructions`，否则 `hook`）：解析结果要写回缓存，
 * 得和自动路径下次带来的 `if_digest` 对得上。
 */
export async function runSkillsSync(options: SkillsSyncOptions): Promise<MaterializeResult & { agent_id: string }> {
  const { host } = options;
  const prepared = await prepare({
    config: options.config,
    agent: options.agent,
    host: host.name,
    baseline: "full",
    fresh: true,
    home: options.home,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    budgetChars: (host.budgets.instructions ?? host.budgets.hook)?.budget_chars,
    maxBytes: host.budgets.instructions?.max_bytes,
  });
  const result = await syncSkills({
    config: options.config,
    host,
    agentId: prepared.agent_id,
    skills: prepared.skills,
    home: options.home,
    fetchImpl: options.fetchImpl,
  });
  return { agent_id: prepared.agent_id, ...result };
}
