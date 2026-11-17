import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * hermes 单宿主真机走查回归：修复暖机（pm repair）+ ck setup --write + ck doctor
 * + 真宿主判定（hooks doctor 判 allowlisted、mcp list 判条目可读）。
 *
 * 前置：pnpm build（packages/cli 与 packages/hub 的 lib/ 产出）；本机装有 hermes v0.23.0+。
 * 运行：node scripts/walk-hermes.mjs；宿主二进制可用 HERMES_BIN 覆盖。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CK = join(REPO, "packages/cli/lib/bin.js");
const HUB_BIN = join(REPO, "packages/hub/lib/bin.js");
const HERMES = process.env.HERMES_BIN || "C:/Users/ASUS/AppData/Local/hermes/bin/hermes.exe";

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail: String(detail).slice(0, 300) });
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 900_000, ...opts });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}
function jsonOf(runResult) {
  const text = runResult.stdout.trim() !== "" ? runResult.stdout : runResult.out;
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

const root = mkdtempSync(join(tmpdir(), "ck-hm-walk-"));
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

const home = join(root, "hermes-user");
const la = join(root, "hermes-la");
mkdirSync(join(la, "hermes"), { recursive: true });
const ckEnv = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  CK_HOME: join(home, ".cinlan-knowledge"),
  CK_HUB_URL: base,
  CK_USER_KEY: user.key.key,
  LOCALAPPDATA: la,
};
const ck = (args) => run(process.execPath, [CK, ...args], { env: ckEnv });

const s = ck(["setup", "--host", "hermes", "--agent", "walk/hm-walker", "--write"]);
record("hermes setup --write", s.code === 0, s.out.slice(-200));
const d = ck(["doctor", "--host", "hermes"]);
const checks = jsonOf(d).checks;
record("hermes doctor", d.code === 0 && Object.values(checks).every((c) => c.ok), Object.entries(checks).map(([k, v]) => `${k}:${v.ok ? "ok" : "FAIL"}`).join(" "));

const hermesEnv = { ...process.env, HERMES_HOME: join(la, "hermes") };
// 修复依赖环境（hermes 自己的路径；一次性）
const repair = run(HERMES, ["pm", "repair"], { env: hermesEnv, cwd: root, timeout: 840_000 });
record("hermes pm repair", repair.code === 0, repair.out.replace(/\s+/g, " ").slice(0, 200));
const hh = run(HERMES, ["hooks", "doctor"], { env: hermesEnv, cwd: root, timeout: 300_000 });
record("hermes hooks doctor（真 v0.23.0）", hh.code === 0 && hh.out.includes("allowlisted"), hh.out.replace(/\s+/g, " ").slice(0, 250));
const ml = run(HERMES, ["mcp", "list"], { env: hermesEnv, cwd: root, timeout: 300_000 });
record("hermes mcp list", ml.code === 0 && ml.out.toLowerCase().includes("ck"), ml.out.replace(/\s+/g, " ").slice(0, 200));

hub.kill();
await new Promise((r) => hub.once("exit", r));
for (let i = 0; i < 10; i++) {
  try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 1));
process.exit(failed.length > 0 ? 1 : 0);
