import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * panel 端到端验收（docs/panel-design.md §8）：起临时 hub（带构建好的 panel）+ 无头浏览器，
 * 用 CDP 走完 登录→资产→共享→审批→配装→团队→访问控制→用量→审计→指南。
 *
 * 用法：pnpm build && pnpm e2e:panel
 * 依赖：本机装了 Edge 或 Chrome（可用 CHROME_PATH 指定）；Node ≥ 22（内置 fetch / WebSocket）。
 * 约定：key 只在进程内传递，不进命令行、不进日志；跑完删临时目录。
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_BIN = join(REPO, "packages", "hub", "lib", "bin.js");
const PANEL_INDEX = join(REPO, "packages", "panel", "dist", "index.html");

const TEAM = "e2e-panel";
const USER = "demo";
const MEMORY_TITLE = "E2E 面板记忆";
const PENDING_TITLE = "E2E 待审记忆";

let hub = null;
let hubClosed = null;
let browser = null;
let dir = null;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function pass(n, title, extra = "") {
  console.log(`PASS ${n} ${title}${extra ? `（${extra}）` : ""}`);
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

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

/** 候选浏览器按序返回；Edge 157 起新 headless 直接退出，起不来的自动换下一个。 */
function findBrowsers() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return [fromEnv];
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const found = candidates.filter((p) => existsSync(p));
  assert(found.length > 0, "找不到 Edge/Chrome；用 CHROME_PATH 指定可执行文件");
  return found;
}

/* ---------- CDP ---------- */

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
    if (res.exceptionDetails) {
      throw new Error(`页面脚本异常：${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    }
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
    const tail = await this.eval("document.body ? document.body.innerText.slice(-400) : ''");
    throw new Error(`等不到文本「${text}」；页面尾部：${String(tail).replace(/\s+/g, " ").slice(0, 200)}`);
  }

  async waitGone(text, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = await this.eval(`document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`);
      if (!hit) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`文本「${text}」一直没消失`);
  }

  /** 按可见文本点 button；找不到返回 false。 */
  clickButton(text) {
    return this.eval(`(() => {
      const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
  }

  /** 点 tbody 里第一行包含给定文本的表格行。 */
  clickRow(text) {
    return this.eval(`(() => {
      const row = [...document.querySelectorAll("tbody tr")].find((tr) => tr.textContent.includes(${JSON.stringify(text)}));
      if (!row) return false;
      row.click();
      return true;
    })()`);
  }

  /** 往 input[placeholder] 里写值，兼容 React 受控组件。 */
  fill(placeholder, value) {
    return this.eval(`(() => {
      const el = document.querySelector('input[placeholder=' + ${JSON.stringify(JSON.stringify(placeholder))} + ']');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }

  fillSelector(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }
}

async function launchBrowser() {
  const profile = join(dir, "browser");
  mkdirSync(profile, { recursive: true });
  const portFile = join(profile, "DevToolsActivePort");
  let proc = null;
  // 逐个候选试启：Edge 157 起新 headless 会立即退出（exit 0、无 stderr），换下一个浏览器重试。
  for (const exe of findBrowsers()) {
    const attempt = spawn(
      exe,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    attempt.stderr.on("data", () => {});
    const deadline = Date.now() + 8_000;
    let up = false;
    while (!existsSync(portFile)) {
      if (attempt.exitCode !== null) break; // 起不来：换下一个候选
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (existsSync(portFile)) {
      proc = attempt;
      break;
    }
    attempt.kill();
  }
  assert(proc !== null && existsSync(portFile), "没有一个候选浏览器能起 headless（Edge 157 已知如此；装 Chrome 或设 CHROME_PATH）");
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const base = `http://127.0.0.1:${port.trim()}`;
  // 新版 Chrome/Edge 要求 PUT；回退 GET 兼容旧版
  let target = null;
  for (const method of ["PUT", "GET"]) {
    const res = await fetch(`${base}/json/new?about:blank`, { method });
    if (res.ok) {
      target = await res.json();
      break;
    }
  }
  assert(target && target.webSocketDebuggerUrl, "建 page target 失败");
  return { proc, page: await Page.open(target.webSocketDebuggerUrl) };
}

async function main() {
  assert(existsSync(HUB_BIN), `hub 构建产物不存在：${HUB_BIN}（先 pnpm build）`);
  assert(existsSync(PANEL_INDEX), `panel 未构建：${PANEL_INDEX}（先 pnpm -F @cinlan/knowledge-panel build）`);

  dir = mkdtempSync(join(tmpdir(), "ck-panel-e2e-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const configFile = join(dir, "hub.json");
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
  assert(boot.code === 0, `bootstrap 失败：${boot.err.trim()}`);
  const saKey = JSON.parse(boot.out).key;

  const log = createWriteStream(join(dir, "hub.log"), { flags: "a" });
  hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout.pipe(log);
  hub.stderr.pipe(log);
  hubClosed = new Promise((resolve) => hub.on("close", resolve));

  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      healthy = r.ok;
    } catch {}
    if (!healthy) await new Promise((r) => setTimeout(r, 100));
  }
  assert(healthy, `${base}/healthz 不通`);

  async function call(action, key, body = {}) {
    const r = await fetch(`${base}/api/v1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const env = await r.json();
    if (r.status !== 200) throw new Error(`${action}: ${r.status} ${JSON.stringify(env).slice(0, 300)}`);
    return env.data;
  }

  /* ---------- 种子数据 ---------- */

  const team = await call("team/create", saKey, { name: TEAM, title: "E2E 面板团队" });
  const demo = await call("user/create-with-key", saKey, { name: USER, display_name: "E2E Demo", key_name: "e2e" });
  const demoKey = demo.key.key;
  await call("team-member/add", saKey, { team_id: team.team.id, user_id: demo.user.id, role: "admin" });

  const memory = await call("asset/create", demoKey, {
    team_id: team.team.id,
    type: "memory",
    title: MEMORY_TITLE,
    content: "面板 e2e 用的记忆正文。",
  });

  // probe 是普通成员：它申请共享会进审批，供 demo 在 /reviews 里裁决。
  const probe = await call("user/create-with-key", saKey, { name: "probe", display_name: "E2E Probe", key_name: "e2e" });
  const probeKey = probe.key.key;
  await call("team-member/add", saKey, { team_id: team.team.id, user_id: probe.user.id, role: "member" });
  const pending = await call("asset/create", probeKey, {
    team_id: team.team.id,
    type: "memory",
    title: PENDING_TITLE,
    content: "这条要等 demo 审批。",
  });
  const share = await call("asset/set-visibility", probeKey, { asset_id: pending.asset.id, visibility: "team" });
  assert(share.status === "pending_review", `probe 的共享应当进入审批，实际 ${share.status}`);

  const agent = await call("agent/create", demoKey, {
    team_id: team.team.id,
    name: "e2e-agent",
    host: "claude-code",
    description: "panel e2e",
  });
  await call("loadout/bind", demoKey, { agent_id: agent.agent.id, asset_id: memory.asset.id, priority: 1 });
  await call("usage/report", demoKey, {
    agent_id: agent.agent.id,
    events: [{ asset_id: memory.asset.id, version: 1, kind: "injected" }],
  });

  /* ---------- 浏览器 ---------- */

  const launched = await launchBrowser();
  browser = launched.proc;
  const page = launched.page;

  // 1. 登录
  await page.goto(`${base}/panel/`);
  await page.waitText("User Key");
  assert(await page.fillSelector('input[type="password"]', demoKey), "找不到 key 输入框");
  assert(await page.clickButton("登录"), "找不到登录按钮");
  await page.waitText("资产库");
  pass(1, "登录（sessionStorage 会话）");

  // 2. 资产库 + 详情抽屉
  await page.waitText(MEMORY_TITLE);
  pass(2, "/assets 列表可见种子资产");
  assert(await page.clickRow(MEMORY_TITLE), "点不到资产行");
  await page.waitText("版本历史");
  pass(3, "资产详情抽屉（版本历史）");

  // 3. 审批：通过 probe 的共享申请
  await page.goto(`${base}/panel/reviews`);
  await page.waitText("审批");
  await page.waitText("当前没有待办的审批").catch(() => {});
  assert(await page.clickRow("共享"), "审批列表里没有 share 申请行");
  await page.waitText("裁决");
  assert(await page.clickButton("通过"), "找不到「通过」按钮");
  await page.waitText("当前没有待办的审批");
  pass(4, "/reviews 裁决通过，队列清空");

  // 4. Agent 配装 + 预算预览
  await page.goto(`${base}/panel/agents/${agent.agent.id}`);
  await page.waitText("配装表");
  await page.waitText(MEMORY_TITLE);
  await page.waitText("预算预览");
  await page.waitText("字符");
  pass(5, "/agents/:id 配装表与预算预览");

  // 5. 团队详情
  await page.goto(`${base}/panel/teams/${team.team.id}`);
  await page.waitText("成员");
  await page.waitText("策略");
  await page.waitText(USER);
  pass(6, "/teams/:id 成员与策略");

  // 6. 访问控制：建一把新 key 并确认明文只弹一次
  await page.goto(`${base}/panel/access`);
  await page.waitText("我的 key");
  await page.waitText("prefix").catch(() => {});
  assert(await page.fill("key 名称，如 laptop", "e2e-second"), "填不进 key 名称");
  assert(await page.clickButton("新建 key"), "找不到「新建 key」按钮");
  await page.waitText("新建的 key 只显示这一次");
  assert(await page.clickButton("我已保存"), "找不到「我已保存」按钮");
  await page.waitGone("新建的 key 只显示这一次");
  pass(7, "/access 建 key，明文弹窗关闭后不可再见");

  // 7. 用量
  await page.goto(`${base}/panel/usage`);
  await page.waitText("注入次数");
  await page.waitText(MEMORY_TITLE);
  pass(8, "/usage 汇总出现注入记录");

  // 8. 审计
  await page.goto(`${base}/panel/audit`);
  await page.waitText("审计");
  await page.waitText("asset/create");
  pass(9, "/audit 有操作流水");

  // 9. 接入指南 + 宿主矩阵
  await page.goto(`${base}/panel/guide`);
  await page.waitText("接入指南");
  await page.waitText("客户端矩阵");
  await page.waitText("Claude Code");
  pass(10, "/guide 渲染宿主矩阵（hosts.json 加载成功）");

  console.log("\nALL PASS 10/10");
}

async function cleanup() {
  try {
    if (browser !== null && browser.exitCode === null) browser.kill();
    if (hub !== null && hub.exitCode === null) hub.kill();
    if (hubClosed) await Promise.race([hubClosed, new Promise((r) => setTimeout(r, 5_000))]);
    if (dir !== null) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    process.stderr.write(`cleanup 未完成（临时目录 ${dir}）：${err.message}\n`);
  }
}

// e2e 脚本是独立进程，cleanup 完主动退出：被杀的浏览器子进程的管道句柄会让事件循环排不空、
// 进程赖着不走（Windows 上 TerminateProcess 之后句柄释放是异步的）。
main()
  .then(() => cleanup().then(() => { process.exit(0); }))
  .catch(async (err) => {
    await cleanup();
    console.error("FAIL " + err.message);
    process.exit(1);
  });
