import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Panel UI 截图走查：临时 hub + 种子数据（真实感中文内容）+ headless 浏览器（CDP），
 * 逐页截图到 %TEMP%\ck-ui-shots\，供视觉评审。只读不写仓库。
 *
 * 运行：node scripts/ui-shoot.mjs；浏览器可用 CHROME_PATH 覆盖（Edge/Chrome 任一，
 * --headless=new）。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_BIN = join(REPO, "packages/hub/lib/bin.js");
const PANEL_INDEX = join(REPO, "packages/panel/dist/index.html");
const SHOTS = join(tmpdir(), "ck-ui-shots");

function findBrowsers() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return [fromEnv];
  return [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((p) => existsSync(p));
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
      else slot.resolve(msg.result);
    });
  }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools WebSocket 连接失败")), { once: true });
    });
    const page = new Page(ws);
    await page.send("Page.enable", {});
    await page.send("Runtime.enable", {});
    return page;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(`页面脚本异常：${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    return res.result.value;
  }
  async goto(path) {
    await this.eval(`location.assign(${JSON.stringify(path)})`);
  }
  async waitText(text, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = await this.eval(`document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`);
      if (hit) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`等不到「${text}」`);
  }
  clickRow(text) {
    return this.eval(`(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(text)}));
      if (!row) return false;
      row.click();
      return true;
    })()`);
  }
  clickButton(text) {
    return this.eval(`(() => {
      const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
  }
  fill(placeholder, value) {
    return this.eval(`(() => {
      const el = document.querySelector('input[placeholder=' + ${JSON.stringify(JSON.stringify(placeholder))} + ']');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }
  async shoot(name) {
    // 视口 1440×900，整页高度截全
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 400));
    const metrics = await this.send("Page.getLayoutMetrics", {});
    const height = Math.ceil(metrics.contentSize.height);
    const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: Math.max(height, 900), scale: 1 } });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
    console.log(`shot ${name}.png (${height}px)`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "ck-ui-shoot-"));
mkdirSync(SHOTS, { recursive: true });
const port = await freePort();
const configFile = join(dir, "hub.json");
const dataDir = join(dir, "data");
mkdirSync(dataDir, { recursive: true });
writeFileSync(configFile, JSON.stringify({ dataDir, listen: { host: "127.0.0.1", port, allowedOrigins: [] }, limits: { maxBodyBytes: 8388608, maxContentBytes: 262144, maxFileBytes: 5242880 }, log: { level: "error" } }, null, 2));

const bootRun = spawnSync(process.execPath, [HUB_BIN, "bootstrap", "--config", configFile, "--name", "root"], { encoding: "utf8" });
if (bootRun.status !== 0) throw new Error(`bootstrap 失败：${bootRun.stderr}`);
const saKey = JSON.parse(bootRun.stdout.slice(bootRun.stdout.indexOf("{"))).key;

const hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
const log = createWriteStream(join(dir, "hub.log"), { flags: "a" });
hub.stdout.pipe(log);
hub.stderr.pipe(log);
const base = `http://127.0.0.1:${port}`;
let healthy = false;
for (let i = 0; i < 100 && !healthy; i++) {
  try { healthy = (await fetch(`${base}/healthz`)).ok; } catch {}
  if (!healthy) await new Promise((r) => setTimeout(r, 100));
}
if (!healthy) throw new Error("hub 未起来");

async function call(action, key, body = {}) {
  const r = await fetch(`${base}/api/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const env = await r.json();
  if (env.code !== 0) throw new Error(`${action}: ${env.code} ${env.message}`);
  return env.data;
}

/* ---------- 种子：真实感数据 ---------- */
const TEAM = "cinlan";
const team = await call("team/create", saKey, { name: TEAM, title: "Cinlan 研发" });
const ly = await call("user/create-with-key", saKey, { name: "ly", display_name: "LY", key_name: "ly-macbook" });
const lyKey = ly.key.key;
await call("team-member/add", saKey, { team_id: team.team.id, user_id: ly.user.id, role: "admin" });
const probe = await call("user/create-with-key", saKey, { name: "shiyi", display_name: "十一", key_name: "shiyi-thinkpad" });
const probeKey = probe.key.key;
await call("team-member/add", saKey, { team_id: team.team.id, user_id: probe.user.id, role: "member" });

const memories = [
  ["发版检查清单", "发布前先跑 pnpm -r test，再翻 releases/current symlink；回滚 = symlink 翻回上一版。\n热修不过夜：先止血（回滚），再定位。", "team"],
  ["值班响应约定", "夜间 P0 告警先看 hub 日志与 /healthz，再拉人；十分钟内必须有响应记录。", "team"],
  ["接口错误码总表", "0 INTERNAL / 401 UNAUTHORIZED / 403 FORBIDDEN / 404 NOT_FOUND / 409 VERSION_CONFLICT / 429 RATE_LIMITED。", "team"],
  ["旧认证模块禁区", "不要重构 legacy auth，移动端仍在用；改动前先找 LY 确认。", "team"],
  ["个人速记：codex 走查口径", "换 --agent 重跑不再是冲突——条目归 ck 所有，原地更新。", "private"],
  ["客户交付话术 v2", "第一句先讲结论，再给证据路径；不要先铺方法论。", "team"],
];
for (const [title, content, visibility] of memories) {
  const a = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title, content, layer: "core" });
  if (visibility !== "private") {
    await call("asset/set-visibility", lyKey, { asset_id: a.asset.id, visibility });
  }
}
// 一条受限资产：给 shiyi 单独读权限（restricted 必须带 acl）
const restricted = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title: "客户交付话术 v2（脱敏稿）", content: "第一句先讲结论，再给证据路径。", layer: "profile" });
await call("asset/set-visibility", lyKey, { asset_id: restricted.asset.id, visibility: "restricted", acl: [{ subject_type: "user", subject_id: probe.user.id, permission: "read" }] });

const skill = await call("asset/create", lyKey, {
  team_id: team.team.id,
  type: "skill",
  name: "deploy-release",
  title: "发版与回滚操作步骤",
  content: "---\nname: deploy-release\ndescription: 发版与回滚的操作步骤\n---\n\n# Deploy\n\n1. pnpm -r test\n2. 打 tag\n3. 翻 symlink current\n4. 观察五分钟",
});
await call("asset/set-visibility", lyKey, { asset_id: skill.asset.id, visibility: "team" });

const deprecated = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title: "旧版部署流程（已废弃）", content: "旧流程：手动 scp。已被 deploy-release 取代。", layer: "profile" });
await call("asset/set-visibility", lyKey, { asset_id: deprecated.asset.id, visibility: "team" });
await call("asset/set-status", lyKey, { asset_id: deprecated.asset.id, action: "deprecate", note: "已被 deploy-release 取代" });

// 待审：shiyi 申请共享
const pendingA = await call("asset/create", probeKey, { team_id: team.team.id, type: "memory", title: "Code Review 惯例", content: "PR 描述里带复现步骤；超过 400 行先拆。" });
await call("asset/set-visibility", probeKey, { asset_id: pendingA.asset.id, visibility: "team", note: "团队新人都在问，建议进全员上下文" });

// 模板 Agent + 绑定
const tpl = await call("agent/create", lyKey, { team_id: team.team.id, name: "template-default", host: "dsh", is_template: true });
await call("loadout/bind", lyKey, { agent_id: tpl.agent.id, asset_id: memories[0] ? (await findAsset("发版检查清单")).id : "", priority: 0, injection_mode: "inject" });
async function findAsset(title) {
  const res = await call("asset/search", lyKey, { query: title, team: TEAM });
  const hit = res.hits.find((h) => h.title === title);
  if (!hit) throw new Error(`种子资产没找到：${title}`);
  return { id: hit.asset_id };
}
await call("loadout/bind", lyKey, { agent_id: tpl.agent.id, asset_id: skill.asset.id, priority: 10, injection_mode: "inject" });
await call("loadout/bind", lyKey, { agent_id: tpl.agent.id, asset_id: (await findAsset("接口错误码总表")).id, priority: 20, injection_mode: "tool" });
await call("agent/set-default-template", lyKey, { team_id: team.team.id, agent_id: tpl.agent.id });

// 正式 Agent + 用量
const agent = await call("agent/ensure", lyKey, { team: TEAM, name: "dsh-ly", host: "dsh" });
const checklist = await findAsset("发版检查清单");
for (let i = 0; i < 6; i++) {
  await call("usage/report", lyKey, { agent_id: agent.agent.id, events: [{ asset_id: checklist.id, version: 1, kind: "injected" }] });
}
await call("usage/report", lyKey, { agent_id: agent.agent.id, events: [{ asset_id: checklist.id, version: 1, kind: "opened" }] });

/* ---------- 浏览器 ---------- */
const profile = join(dir, "browser");
mkdirSync(profile, { recursive: true });
const portFile = join(profile, "DevToolsActivePort");
let browserProc = null;
for (const exe of findBrowsers()) {
  const attempt = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  attempt.stderr.on("data", () => {});
  const deadline = Date.now() + 8000;
  while (!existsSync(portFile)) {
    if (attempt.exitCode !== null) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (existsSync(portFile)) { browserProc = attempt; break; }
  attempt.kill();
}
if (!browserProc) throw new Error("没有可用的 headless 浏览器");
const [cdpPort] = readFileSync(portFile, "utf8").split("\n");
const cdpBase = `http://127.0.0.1:${cdpPort.trim()}`;
let target = null;
for (const method of ["PUT", "GET"]) {
  const res = await fetch(`${cdpBase}/json/new?about:blank`, { method });
  if (res.ok) { target = await res.json(); break; }
}
const page = await Page.open(target.webSocketDebuggerUrl);

/* ---------- 登录 + 截图 ---------- */
await page.goto(`${base}/panel/login`);
await page.waitText("登录");
await page.shoot("01-login");

await page.fill("ck_…", lyKey);
await page.clickButton("登录");
await page.waitText("资产");
await page.shoot("02-assets");

// 资产详情抽屉
if (await page.clickRow("发版检查清单")) {
  await page.waitText("版本历史");
  await page.shoot("03-asset-detail");
}

await page.goto(`${base}/panel/reviews`);
await page.waitText("审批");
await page.shoot("04-reviews");

await page.goto(`${base}/panel/agents`);
await page.waitText("Agent");
await page.shoot("05-agents");

if (await page.clickRow("dsh-ly")) {
  await page.waitText("配装");
  await page.shoot("06-agent-detail");
}

await page.goto(`${base}/panel/teams`);
await page.waitText("团队");
await page.shoot("07-teams");

if (await page.clickRow("Cinlan 研发")) {
  await page.waitText("成员");
  await page.shoot("08-team-detail");
}

await page.goto(`${base}/panel/access`);
await page.waitText("key");
await page.shoot("09-access");

await page.goto(`${base}/panel/usage`);
await page.waitText("用量");
await page.shoot("10-usage");

await page.goto(`${base}/panel/audit`);
await page.waitText("审计");
await page.shoot("11-audit");

await page.goto(`${base}/panel/guide`);
await page.waitText("接入指南");
await page.shoot("12-guide");

console.log(`DONE → ${SHOTS}`);
browserProc.kill();
hub.kill();
await new Promise((r) => hub.once("exit", r));
process.exit(0);
