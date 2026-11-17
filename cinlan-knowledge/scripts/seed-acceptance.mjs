import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 实机验收用种子数据（docs/acceptance-manual.md）。
 *
 * 起一个临时 hub，种一个团队 + 一个用户 key + 一条 inject 记忆（标题带「验收标记-CHECKPOINT」）
 * + 一个 skill，打印 hub 地址 / key / Agent 名。Ctrl-C 只停 hub，**不删库**，数据留在 --dir 里，
 * 跑完按屏幕上的清理提示手工删。
 *
 * 用法：
 *   node scripts/seed-acceptance.mjs                 # 数据落在 %TEMP%/ck-acceptance-<时间戳>
 *   node scripts/seed-acceptance.mjs --dir D:\ck-acc # 指定数据目录
 *
 * key 是本地一次性 key，只用于验收；控制台会打印明文（手工验收要用），不要贴到任何地方。
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_BIN = join(REPO, "packages/hub/lib/bin.js");

const TEAM = "acceptance";
const USER = "demo";
const MEMORY_TITLE = "验收标记-CHECKPOINT";
const SKILL_NAME = "acceptance-checkpoint";

let hubProcess = null;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function run(args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (code) => res({ code, out, err }));
  });
}

async function main() {
  if (!existsSync(HUB_BIN)) {
    throw new Error(`hub 未构建：缺 ${HUB_BIN}，先在仓库根跑 pnpm -r build`);
  }

  const dir = resolve(arg("--dir") ?? join(tmpdir(), `ck-acceptance-${Date.now()}`));
  const dataDir = join(dir, "data");
  const configFile = join(dir, "hub.json");
  const logFile = join(dir, "hub.log");
  mkdirSync(dataDir, { recursive: true });

  const port = await freePort();
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        dataDir,
        listen: { host: "127.0.0.1", port, allowedOrigins: [] },
        limits: { maxBodyBytes: 8388608, maxContentBytes: 262144, maxFileBytes: 5242880 },
        log: { level: "error" },
      },
      null,
      2,
    ),
  );

  const boot = await run([HUB_BIN, "bootstrap", "--config", configFile, "--name", "root"]);
  if (boot.code !== 0) throw new Error("bootstrap 失败：" + boot.err.trim());
  const saKey = JSON.parse(boot.out).key;

  const log = createWriteStream(logFile, { flags: "a" });
  const hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", configFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  hubProcess = hub;
  hub.stdout.pipe(log);
  hub.stderr.pipe(log);

  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      healthy = r.ok;
    } catch {}
    if (!healthy) await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) throw new Error(`hub 未起：${base}/healthz 不通，日志见 ${logFile}`);

  async function call(action, key, body = {}) {
    const r = await fetch(`${base}/api/v1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const env = await r.json();
    if (r.status !== 200) throw new Error(`${action}: ${r.status} ${JSON.stringify(env)}`);
    return env.data;
  }

  // 团队只能由 SA 建；demo 作为 Team Admin 参与，后续资产与配装都用 demo 的 key 做
  // （自批只看 teamRole === "admin"，不要求建队者本人）。
  // probe 是另一个团队成员，只用于"换 key 搜不到私有记忆"的验收项。
  const team = await call("team/create", saKey, { name: TEAM, title: "验收团队" });
  const demo = await call("user/create-with-key", saKey, { name: USER, display_name: "验收 Demo", key_name: "acceptance" });
  const demoKey = demo.key.key;
  await call("team-member/add", saKey, { team_id: team.team.id, user_id: demo.user.id, role: "admin" });
  const probe = await call("user/create-with-key", saKey, { name: "probe", display_name: "验收 Probe", key_name: "acceptance" });
  const probeKey = probe.key.key;
  await call("team-member/add", saKey, { team_id: team.team.id, user_id: probe.user.id, role: "member" });

  const memory = await call("asset/create", demoKey, {
    team_id: team.team.id,
    type: "memory",
    title: MEMORY_TITLE,
    content:
      "本条是实机验收用的记忆资产。\n\n" +
      "验收约定：当被问到「验收暗号」时，回答 BLUE-FALCON-42。\n\n" +
      "看到 BLUE-FALCON-42 说明：hub 连通、key 有效、模板配装下发、inject 注入链路完整。",
  });
  // TA 自批共享，立即对团队可见
  const shared = await call("asset/set-visibility", demoKey, {
    asset_id: memory.asset.id,
    visibility: "team",
  });
  if (shared.status !== "applied") {
    throw new Error("记忆共享未自批生效：" + JSON.stringify(shared));
  }

  const skill = await call("asset/create", demoKey, {
    team_id: team.team.id,
    type: "skill",
    name: SKILL_NAME,
    title: "验收 skill（ACCEPTANCE-SKILL-OK）",
    content: [
      "---",
      `name: ${SKILL_NAME}`,
      "description: 实机验收专用 skill；被调用时输出 ACCEPTANCE-SKILL-OK 与验收标记。",
      "---",
      "",
      "# 验收 skill",
      "",
      "当主模型调用本 skill 时，原样输出下面这行，不做任何加工：",
      "",
      "`ACCEPTANCE-SKILL-OK 验收标记-CHECKPOINT`",
      "",
      "输出后补充一句：本 skill 已从 cinlan-knowledge hub 物化到本机 skill 目录。",
      "",
    ].join("\n"),
  });

  const tpl = await call("agent/create", demoKey, {
    team_id: team.team.id,
    name: "acceptance-tpl",
    host: "claude-code",
    description: "验收模板：1 条 inject 记忆 + 1 个 inject skill",
    is_template: true,
  });
  await call("loadout/bind", demoKey, { agent_id: tpl.agent.id, asset_id: memory.asset.id, priority: 1 });
  await call("loadout/bind", demoKey, { agent_id: tpl.agent.id, asset_id: skill.asset.id, priority: 2 });
  await call("agent/set-default-template", demoKey, { team_id: team.team.id, agent_id: tpl.agent.id });

  const agents = [
    { host: "dsh", name: `${TEAM}/demo-dsh` },
    { host: "cinlan-harness", name: `${TEAM}/demo-clh` },
    { host: "claude-code", name: `${TEAM}/demo-cc` },
  ];

  const lines = [
    "",
    "=== 验收数据已就绪（Ctrl-C 只停 hub，不删数据）===",
    "",
    `hub      ${base}`,
    `数据目录 ${dir}`,
    `团队     ${TEAM}`,
    `用户     ${USER}（Team Admin） + probe（member，仅用于跨用户隔离验收）`,
    `模板     acceptance-tpl（记忆 inject + skill inject）`,
    `记忆     ${MEMORY_TITLE}（暗号 BLUE-FALCON-42）`,
    `skill    ${SKILL_NAME}`,
    "",
    "用户 key（一次性，只用在这个临时 hub 上；登录后从控制台消失）：",
    "",
    `  demo  ${demoKey}`,
    `  probe ${probeKey}`,
    "",
    "登录（key 走 stdin，不落 shell 历史请用文件或粘贴后回车）：",
    "",
    `  ck login --hub ${base}`,
    "",
    "三个宿主的 Agent 名（首次运行自动 agent/ensure，套用模板）：",
    ...agents.map((a) => `  ${a.host.padEnd(15)} ${a.name}`),
    "",
    "宿主配置（验收手册第 2 节起）：",
    "",
    "  ck setup --host dsh            --agent " + agents[0].name + " --write",
    "  ck setup --host cinlan-harness --agent " + agents[1].name + " --write",
    "  ck setup --host claude-code    --agent " + agents[2].name + " --write",
    "",
    `hub 日志 ${logFile}`,
    "",
    "清理（验收完、hub 已停后）：",
    "",
    `  rm -rf "${dir}"          # PowerShell: Remove-Item -Recurse -Force "${dir}"`,
    "  ck login --hub <你自己的 hub>   # 把本机 key 换回正式环境",
    `  # 若装过宿主配置：删掉各宿主 MCP 里的 ck 条目，或把备份的 .bak 还原`,
    "",
  ];
  console.log(lines.join("\n"));

  const stop = () => {
    hub.kill();
    log.end();
    console.log(`\n已停止 hub。数据保留在 ${dir}，按上面的清理提示手工删。`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  hub.on("close", (code) => {
    console.log(`\nhub 进程已退出（code ${code}）。数据保留在 ${dir}。`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FAIL " + err.message);
  if (hubProcess !== null && hubProcess.exitCode === null) hubProcess.kill();
  process.exitCode = 1;
});
