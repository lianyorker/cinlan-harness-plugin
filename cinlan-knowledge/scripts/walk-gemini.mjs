import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * gemini 单宿主真机走查回归：ck setup --write + ck doctor + 真宿主读回（mcp list）。
 * runShell 两元素分传；判定「条目可读」（Disabled/Connected 均可）。
 *
 * 前置：pnpm build（packages/cli 与 packages/hub 的 lib/ 产出）；本机装有 gemini-cli。
 * 运行：node scripts/walk-gemini.mjs；宿主二进制可用 GEMINI_BIN 覆盖。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CK = join(REPO, "packages/cli/lib/bin.js");
const HUB_BIN = join(REPO, "packages/hub/lib/bin.js");
const GEMINI = process.env.GEMINI_BIN || "C:/Users/ASUS/AppData/Local/npm-cache/_npx/d07ada7b4a99c96e/node_modules/.bin/gemini.cmd";

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail: String(detail).slice(0, 300) });
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...opts });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}
function jsonOf(runResult) {
  const text = runResult.stdout.trim() !== "" ? runResult.stdout : runResult.out;
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

const root = mkdtempSync(join(tmpdir(), "ck-gm-walk-"));
const freePort = await new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const cfg = join(root, "hub.json");
writeFileSync(cfg, JSON.stringify({ dataDir: join(root, "data"), listen: { host: "127.0.0.1", port: freePort }, log: { level: "error" } }, null, 2));
const boot = run(process.execPath, [HUB_BIN, "bootstrap", "--config", cfg, "--name", "root"]);
const saKey = jsonOf(boot).key;
const hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", cfg], { stdio: ["ignore", "ignore", "ignore"] });
const base = `http://127.0.0.1:${freePort}`;
let healthy = false;
for (let i = 0; i < 100 && !healthy; i++) {
  try { healthy = (await fetch(`${base}/healthz`)).ok; } catch {}
  if (!healthy) await new Promise((r) => setTimeout(r, 100));
}
async function api(action, key, body = {}) {
  const r = await fetch(`${base}/api/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const env = await r.json();
  if (env.code !== 0) throw new Error(`${action}: ${env.code} ${env.message}`);
  return env.data;
}
const team = await api("team/create", saKey, { name: "walk", title: "Walk" });
const user = await api("user/create-with-key", saKey, { name: "walker", display_name: "Walker", key_name: "w" });
await api("team-member/add", saKey, { team_id: team.team.id, user_id: user.user.id, role: "admin" });

const home = join(root, "gemini-user");
const gemDir = join(home, ".gemini");
const ckEnv = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  CK_HOME: join(home, ".cinlan-knowledge"),
  CK_HUB_URL: base,
  CK_USER_KEY: user.key.key,
};
const ck = (args) => run(process.execPath, [CK, ...args], { env: ckEnv });

const s = ck(["setup", "--host", "gemini-cli", "--agent", "walk/gm-walker", "--write"]);
record("gemini setup --write", s.code === 0, s.out.slice(-200));
const d = ck(["doctor", "--host", "gemini-cli"]);
const checks = jsonOf(d).checks;
record("gemini doctor", d.code === 0 && Object.values(checks).every((c) => c.ok), Object.entries(checks).map(([k, v]) => `${k}:${v.ok ? "ok" : "FAIL"}`).join(" "));

// 真宿主读回：GEMINI_CLI_HOME 的语义按 bundle 源码 paths.ts 是 homedir 的替代
//（settings 在 <GEMINI_CLI_HOME>/.gemini/settings.json）；也可能按环境直接读。两种都试，
// 任一读出条目即通过——条目可读（Disabled/Connected 均可）才是验证目标。
const tryList = (envLabel, cliHome) => {
  const r = run(GEMINI, ["mcp", "list"], {
    shell: true,
    env: { ...process.env, GEMINI_CLI_HOME: cliHome },
    cwd: root,
    timeout: 300_000,
  });
  const listed = /ck/.test(r.out) && /--host gemini-cli/.test(r.out);
  record(`gemini mcp list（真 0.68.0，${envLabel}）`, r.code === 0 && listed, r.out.replace(/\s+/g, " ").slice(0, 250));
  return listed;
};
const viaUserHome = tryList("GEMINI_CLI_HOME=userHome", home);
if (!viaUserHome) tryList("GEMINI_CLI_HOME=.gemini", gemDir);

hub.kill();
await new Promise((r) => hub.once("exit", r));
for (let i = 0; i < 10; i++) {
  try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 1));
process.exit(failed.length > 0 ? 1 : 0);
