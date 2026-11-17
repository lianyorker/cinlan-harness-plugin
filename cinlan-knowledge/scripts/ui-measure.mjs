import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Panel UI 实测走查：起临时 hub + 种子数据 + headless 浏览器（CDP），
 * 逐页抽取 computed style 统计（字号/文本色/圆角/内边距/边框色的去重集合
 * + 结构密度），输出 JSON 供设计审计；结果同时落到 %TEMP%\ck-ui-measure.json。
 *
 * 运行：node scripts/ui-measure.mjs；浏览器可用 CHROME_PATH 覆盖（Edge/Chrome 任一，
 * --headless=new）。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_BIN = join(REPO, "packages/hub/lib/bin.js");

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
  /** 页面级样式统计：只统计可视区内、非脚本的元素。 */
  async stats() {
    return this.eval(`(() => {
      const sizes = new Set(), colors = new Set(), radii = new Set(), paddings = new Set(), borders = new Set();
      let visible = 0, cards = 0, tables = 0, buttons = 0, shadows = 0;
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        visible++;
        const fs = cs.fontSize;
        if (el.textContent.trim()) sizes.add(fs);
        if (el.textContent.trim()) colors.add(cs.color);
        radii.add(cs.borderRadius);
        borders.add(cs.borderColor);
        if (cs.boxShadow !== 'none') shadows++;
        const pad = cs.padding;
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') paddings.add(pad);
        if (el.className && String(el.className).includes && (String(el.className).includes('ck-panel') || String(el.className).includes('ck-kpi') || String(el.className).includes('ck-filters') || String(el.className).includes('t-card'))) cards++;
        if (el.tagName === 'TABLE') tables++;
        if (el.tagName === 'BUTTON') buttons++;
      }
      const firstHeading = document.querySelector('.ck-page-title, .ck-login-title');
      return {
        visible,
        cards, tables, buttons, shadows,
        sizes: [...sizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
        colors: [...colors],
        radii: [...radii],
        paddings: [...paddings],
        borders: [...borders].slice(0, 12),
        titleSize: firstHeading ? getComputedStyle(firstHeading).fontSize : null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        mainPadding: (() => { const m = document.querySelector('.ck-main-inner'); return m ? getComputedStyle(m).padding : null; })(),
        siderWidth: (() => { const s = document.querySelector('.ck-sider'); return s ? s.getBoundingClientRect().width : null; })(),
        textSample: document.body.innerText.slice(0, 120).replace(/\\s+/g, ' '),
      };
    })()`);
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

const dir = mkdtempSync(join(tmpdir(), "ck-ui-meas-"));
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

const team = await call("team/create", saKey, { name: "cinlan", title: "Cinlan 研发" });
const ly = await call("user/create-with-key", saKey, { name: "ly", display_name: "LY", key_name: "ly-macbook" });
await call("team-member/add", saKey, { team_id: team.team.id, user_id: ly.user.id, role: "admin" });
const lyKey = ly.key.key;
const titles = [
  ["发版检查清单", "发布前先跑 pnpm -r test，再翻 releases/current symlink；回滚 = symlink 翻回上一版。", "team"],
  ["值班响应约定", "夜间 P0 告警先看 hub 日志与 /healthz，再拉人。", "team"],
  ["接口错误码总表", "0 INTERNAL / 401 UNAUTHORIZED / 403 FORBIDDEN / 404 NOT_FOUND。", "team"],
  ["旧认证模块禁区", "不要重构 legacy auth，移动端仍在用。", "team"],
  ["个人速记", "换 --agent 重跑不再是冲突。", "private"],
];
for (const [t, c, v] of titles) {
  const a = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title: t, content: c, layer: "core" });
  if (v !== "private") await call("asset/set-visibility", lyKey, { asset_id: a.asset.id, visibility: v });
}
const skill = await call("asset/create", lyKey, { team_id: team.team.id, type: "skill", name: "deploy-release", title: "发版与回滚操作步骤", content: "---\nname: deploy-release\ndescription: 发版与回滚的操作步骤\n---\n\n# Deploy\n\n1. pnpm -r test\n2. 打 tag" });
await call("asset/set-visibility", lyKey, { asset_id: skill.asset.id, visibility: "team" });
const agent = await call("agent/ensure", lyKey, { team: "cinlan", name: "dsh-ly", host: "dsh" });

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
await browserProc;
const [cdpPort] = readFileSync(portFile, "utf8").split("\n");
const cdpBase = `http://127.0.0.1:${cdpPort.trim()}`;
let target = null;
for (const method of ["PUT", "GET"]) {
  const res = await fetch(`${cdpBase}/json/new?about:blank`, { method });
  if (res.ok) { target = await res.json(); break; }
}
const page = await Page.open(target.webSocketDebuggerUrl);
await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const out = {};
await page.goto(`${base}/panel/login`);
await page.waitText("登录");
out.login = await page.stats();
await page.fill("ck_…", lyKey);
await page.clickButton("登录");
await page.waitText("资产");
out.assets = await page.stats();
if (await page.clickRow("发版检查清单")) {
  await page.waitText("版本历史");
  out.assetDetail = await page.stats();
}
await page.goto(`${base}/panel/reviews`);
await page.waitText("审批");
out.reviews = await page.stats();
await page.goto(`${base}/panel/agents`);
await page.waitText("Agent");
out.agents = await page.stats();
if (await page.clickRow("dsh-ly")) {
  await page.waitText("配装");
  out.agentDetail = await page.stats();
}
await page.goto(`${base}/panel/teams`);
await page.waitText("团队");
out.teams = await page.stats();
await page.goto(`${base}/panel/access`);
await page.waitText("key");
out.access = await page.stats();
await page.goto(`${base}/panel/usage`);
await page.waitText("用量");
out.usage = await page.stats();
await page.goto(`${base}/panel/audit`);
await page.waitText("审计");
out.audit = await page.stats();
await page.goto(`${base}/panel/guide`);
await page.waitText("接入指南");
out.guide = await page.stats();

writeFileSync(join(tmpdir(), "ck-ui-measure.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
browserProc.kill();
hub.kill();
await new Promise((r) => hub.once("exit", r));
rmSync(dir, { recursive: true, force: true });
