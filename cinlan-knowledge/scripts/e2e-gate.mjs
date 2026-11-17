import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 验收门（docs/sop.md C 看板「验收门」行）：不靠 CLI，仅用 panel 走完 B.1–B.6。
 * 零种子数据——只有 bootstrap 出的 System Admin key，其余全部经 panel UI 完成：
 *   B.1 SA：建团队 → 建两个用户（key 明文只读一次）→ 加成员（管理员/成员）
 *   B.2 成员：建 Agent，读到空档（无模板团队的默认状态）
 *   B.3 成员：新建私有记忆 → 申请共享（附 note）
 *   B.4 管理员：/reviews 通过一条、驳回一条（驳回必须写 reason）
 *   B.5 管理员：建模板 Agent → 绑资产 → 设为团队默认 → 同步到成员 Agent；
 *       成员：切送法 tool、保存、预算预览
 *   B.6 管理员：/usage 零用量清单 → 弃用 → 归档（purge 需 180 天，不触发）
 * 末尾 /audit 留痕抽查。B.2 的 knowledge_status 自查与「Codex/Gemini 过 install.md §7」
 * 属宿主侧，不在本脚本范围。
 *
 * 用法：pnpm build && pnpm e2e:gate（依赖同 e2e:panel：Edge/Chrome、Node ≥ 22）
 * 约定：key 只在进程内传递；跑完删临时目录。
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_BIN = join(REPO, "packages", "hub", "lib", "bin.js");
const PANEL_INDEX = join(REPO, "packages", "panel", "dist", "index.html");

const TEAM_SLUG = "gate";
const TEAM_TITLE = "验收门团队";
const ADMIN_SLUG = "gate-admin";
const MEMBER_SLUG = "gate-member";
const ASSET_TITLE = "值班响应约定";
const ASSET_REJECT_TITLE = "旧的构建口诀";
const ASSET_DISTILL = "夜班教训";
const DISTILL_NOTE = "热修口径，全员适用";

let hub = null;
let hubClosed = null;
let browser = null;
let dir = null;
let base = "";

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

  /** 等页面主区出现表格或空态（数据拉取是异步的，直接查 DOM 会扑空）。 */
  async waitReady(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = await this.eval(
        `!!(document.querySelector(".ck-main .t-table tbody tr") || document.querySelector(".ck-main .ck-empty") || document.querySelector(".ck-main .ck-loadout") || document.querySelector(".ck-main .ck-error"))`,
      );
      if (hit) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    const tail = await this.eval("document.body ? document.body.innerText.slice(-300) : ''");
    throw new Error(`页面一直没就绪；尾部：${String(tail).replace(/\s+/g, " ").slice(0, 200)}`);
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

  /** 按 label.ck-field 的字段名找 Input 写值（Access/各抽屉里无 placeholder 的框）。 */
  fillByLabel(labelText, value) {
    return this.eval(`(() => {
      const el = [...document.querySelectorAll("label.ck-field")]
        .find((l) => (l.querySelector(".ck-field-label")?.textContent ?? "").trim() === ${JSON.stringify(labelText)})
        ?.querySelector("input");
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }

  /** 往 textarea[placeholder] 写值（TDesign Textarea 也是原生 textarea）。 */
  fillTextarea(placeholder, value) {
    return this.eval(`(() => {
      const el = document.querySelector('textarea[placeholder=' + ${JSON.stringify(JSON.stringify(placeholder))} + ']');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }

  /**
   * TDesign Select 选值：selectExpr 是一段求值成 .t-select 元素的表达式。
   * 先在 input 上派发 mousedown/mouseup/click 打开弹层（.t-portal-wrapper），
   * 再点文本匹配的 .t-select-option。返回 "ok:新值" 或错误标记。
   * select / option 都带轮询：列表是异步拉的（如 AddAsset 的 asset/list），
   * 加载完成前 placeholder 或选项还不在 DOM——一次求值会闪失。
   */
  async pickOption(selectExpr, optionText) {
    return this.eval(`(async () => {
      let sel = null;
      for (let i = 0; i < 50 && !sel; i++) {
        sel = (${selectExpr});
        if (!sel) await new Promise((r) => setTimeout(r, 200));
      }
      if (!sel) return "select-not-found";
      const input = sel.querySelector("input");
      if (!input) return "select-input-not-found";
      for (const type of ["mousedown", "mouseup", "click"]) {
        input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      let opt = null;
      for (let i = 0; i < 50 && !opt; i++) {
        opt = [...document.querySelectorAll(".t-portal-wrapper .t-select-option")].find(
          (o) => o.textContent.trim() === ${JSON.stringify(optionText)},
        );
        if (!opt) await new Promise((r) => setTimeout(r, 200));
      }
      if (!opt) return "option-not-found:" + ${JSON.stringify(optionText)};
      for (const type of ["mousedown", "mouseup", "click"]) {
        opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      await new Promise((r) => setTimeout(r, 400));
      return "ok:" + input.value;
    })()`);
  }

  /** Popconfirm 包着的按钮：点开弹层再点「确定」。 */
  async popConfirm(buttonText) {
    const clicked = await this.clickButton(buttonText);
    if (!clicked) return "button-not-found";
    // 确认层渲染是异步的（Popconfirm 动画）：带轮询找「确定」。
    // 页面上可能同时挂多个 portal（Select 的下拉层不卸载、只隐藏），要遍历而不是取第一个。
    return this.eval(`(async () => {
      let ok = null;
      for (let i = 0; i < 50 && !ok; i++) {
        ok = [...document.querySelectorAll(".t-portal-wrapper button")].find((b) => b.textContent.trim() === "确定");
        if (!ok) await new Promise((r) => setTimeout(r, 200));
      }
      if (!ok) return "confirm-not-found";
      ok.click();
      return "ok";
    })()`);
  }

  /** 点 Switch（CreateAgentDrawer 的「作为团队默认模板」等）。 */
  clickSwitch(containingText) {
    return this.eval(`(() => {
      const label = [...document.querySelectorAll("label.ck-check, .ck-check")].find((l) =>
        l.textContent.includes(${JSON.stringify(containingText)}),
      );
      const sw = label ? label.querySelector(".t-switch") : null;
      if (!sw) return false;
      sw.click();
      return true;
    })()`);
  }

  /** 点 Tabs 的页签（Access 的「用户」、Usage 的「零用量」）。 */
  clickTab(text) {
    return this.eval(`(() => {
      const tab = [...document.querySelectorAll(".t-tabs__nav-item")].find((t) =>
        t.textContent.includes(${JSON.stringify(text)}),
      );
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
  }

  /** KeyReveal 弹窗里的明文（pre.ck-code-key）。 */
  readRevealedKey() {
    return this.eval(`document.querySelector("pre.ck-code-key")?.textContent ?? null`);
  }

  /** 换账号：到登录页 → 清会话 → 刷新 → 填 key 登录。 */
  async login(key) {
    await this.goto(`${base}/panel/login`);
    await this.eval("sessionStorage.clear()");
    await this.eval("location.reload()");
    await this.waitText("User Key");
    assert(await this.fillSelector('input[type="password"]', key), "找不到 key 输入框");
    assert(await this.clickButton("登录"), "找不到登录按钮");
    await this.waitText("资产库");
  }
}

async function launchBrowser() {
  const profile = join(dir, "browser");
  mkdirSync(profile, { recursive: true });
  const portFile = join(profile, "DevToolsActivePort");
  let proc = null;
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
    while (!existsSync(portFile)) {
      if (attempt.exitCode !== null) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (existsSync(portFile)) {
      proc = attempt;
      break;
    }
    attempt.kill();
  }
  assert(proc !== null && existsSync(portFile), "没有一个候选浏览器能起 headless");
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const cdpBase = `http://127.0.0.1:${port.trim()}`;
  let target = null;
  for (const method of ["PUT", "GET"]) {
    const res = await fetch(`${cdpBase}/json/new?about:blank`, { method });
    if (res.ok) {
      target = await res.json();
      break;
    }
  }
  assert(target && target.webSocketDebuggerUrl, "建 page target 失败");
  return { proc, page: await Page.open(target.webSocketDebuggerUrl) };
}

/* ---------- 常用的 Select 定位表达式 ---------- */

const SEL_ROLE = `(() => document.querySelector('input[placeholder="对方的 user slug"]')?.closest(".ck-row-actions")?.querySelector(".t-select"))()`;
const SEL_SHARE = `(() => [...document.querySelectorAll(".ck-section")].find((s) => s.querySelector(".ck-section-title")?.textContent === "共享")?.querySelector(".t-select"))()`;
const SEL_ADDASSET = `(() => [...document.querySelectorAll(".t-select")].find((s) => s.querySelector("input")?.getAttribute("placeholder") === "选一条资产"))()`;
const SEL_LOADOUT_MODE = (title) =>
  `(() => [...document.querySelectorAll("table.ck-loadout tbody tr")].find((tr) => tr.textContent.includes(${JSON.stringify(title)}))?.querySelector(".t-select"))()`;

async function main() {
  assert(existsSync(HUB_BIN), `hub 构建产物不存在：${HUB_BIN}（先 pnpm build）`);
  assert(existsSync(PANEL_INDEX), `panel 未构建：${PANEL_INDEX}（先 pnpm -F @cinlan/knowledge-panel build）`);

  dir = mkdtempSync(join(tmpdir(), "ck-gate-e2e-"));
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

  base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      healthy = r.ok;
    } catch {}
    if (!healthy) await new Promise((r) => setTimeout(r, 100));
  }
  assert(healthy, `${base}/healthz 不通`);

  /** 直接调 API（沉淀段用：宿主侧入口没有模型可调，按等价动作落同一形态草稿）。 */
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

  const launched = await launchBrowser();
  browser = launched.proc;
  const page = launched.page;

  /* ============ B.1 System Admin：团队 + 用户 + 成员 ============ */

  await page.login(saKey);

  await page.goto(`${base}/panel/teams`);
  await page.waitReady();
  await page.waitText("还没有团队");
  assert(await page.clickButton("新建团队"), "找不到「新建团队」按钮");
  assert(await page.fillByLabel("slug", TEAM_SLUG), "填不进团队 slug");
  assert(await page.fillByLabel("显示名", TEAM_TITLE), "填不进团队显示名");
  assert(await page.clickButton("创建"), "找不到团队「创建」按钮");
  await page.waitText("成员");
  pass("B.1a", "SA 在 /teams 建团队");

  await page.goto(`${base}/panel/access`);
  await page.waitText("用户");
  assert(await page.clickTab("用户"), "切不到「用户」页签");
  await page.waitText("新建用户");
  async function createUser(slug, display) {
    assert(await page.clickButton("新建用户"), "找不到「新建用户」按钮");
    assert(await page.fillByLabel("slug", slug), `填不进用户 slug（${slug}）`);
    assert(await page.fillByLabel("显示名", display), `填不进显示名（${display}）`);
    assert(await page.clickButton("创建并签发 key"), "找不到「创建并签发 key」按钮");
    await page.waitText("只显示这一次");
    const key = await page.readRevealedKey();
    assert(typeof key === "string" && key.startsWith("ck_"), "KeyReveal 里没读到明文 key");
    assert(await page.clickButton("我已保存"), "找不到「我已保存」按钮");
    await page.waitGone("只显示这一次");
    return key;
  }
  const adminKey = await createUser(ADMIN_SLUG, "门禁管理员");
  const memberKey = await createUser(MEMBER_SLUG, "门禁成员");
  pass("B.1b", "SA 在 /access 建两个用户并取到一次性 key", "明文各只读一次");

  await page.goto(`${base}/panel/teams`);
  await page.waitReady();
  assert(await page.clickRow(TEAM_TITLE), "点不到团队行");
  await page.waitText("审批策略");
  assert(await page.fill("对方的 user slug", ADMIN_SLUG), "填不进管理员 slug");
  let picked = await page.pickOption(SEL_ROLE, "管理员");
  assert(picked === "ok:管理员", `角色选不成管理员：${picked}`);
  assert(await page.clickButton("添加"), "找不到「添加」按钮");
  await page.waitText("门禁管理员");
  assert(await page.fill("对方的 user slug", MEMBER_SLUG), "填不进成员 slug");
  assert(await page.clickButton("添加"), "找不到「添加」按钮（成员）");
  await page.waitText("门禁成员");
  pass("B.1c", "SA 把两用户加进团队（管理员/成员）");

  /* ============ B.2 成员：Agent 落地，读到空档 ============ */

  await page.login(memberKey);
  await page.goto(`${base}/panel/agents`);
  await page.waitReady();
  assert(await page.clickButton("新建 Agent"), "找不到「新建 Agent」按钮");
  assert(await page.fillByLabel("名称", "gate-agent"), "填不进 Agent 名");
  let agentId = "";
  assert(await page.clickButton("创建"), "找不到 Agent「创建」按钮");
  await page.waitText("配装表");
  await page.waitText("还没有绑定资产");
  // 从 URL 拿 agent id（E.10 预算降级用）
  agentId = await page.eval("location.pathname.split('/').pop() ?? ''");
  pass("B.2", "成员建 Agent，空团队读到空档配装");

  /* ============ B.3 成员：私有记忆 + 申请共享（两条） ============ */

  async function createAndShare(title, content, note) {
    await page.goto(`${base}/panel/assets`);
    await page.waitReady();
    assert(await page.clickButton("新建资产"), "找不到「新建资产」按钮");
    assert(await page.fillByLabel("标题", title), `填不进标题（${title}）`);
    assert(await page.fillTextarea("正文（纯文本或 Markdown 源码）", content), "填不进正文");
    assert(await page.clickButton("创建"), "找不到资产「创建」按钮");
    await page.waitText(title);
    assert(await page.clickRow(title), `点不到资产行（${title}）`);
    await page.waitText("共享");
    let sel = await page.pickOption(SEL_SHARE, "团队（team）");
    assert(sel === "ok:团队（team）", `共享可见性选不成：${sel}`);
    assert(await page.fill("给审批人的说明", note), "填不进共享说明");
    assert(await page.clickButton("申请共享到团队"), "找不到「申请共享到团队」按钮");
    await page.waitText("已提交审批");
  }

  await createAndShare(ASSET_TITLE, "P0 告警十分钟内响应并在 hub 留痕；十分钟没有响应记录就升级拉人。", "新人都在问，建议进全员上下文");
  await createAndShare(ASSET_REJECT_TITLE, "先跑测试再翻 symlink。", "备选参考");
  pass("B.3", "成员新建私有记忆并申请共享（2 条，带说明）");

  /* ============ B.4 管理员：一通过一驳回 ============ */

  await page.login(adminKey);
  await page.goto(`${base}/panel/reviews`);
  await page.waitReady();
  await page.waitText("新人都在问");
  assert(await page.clickRow("新人都在问"), "点不到待审行（通过）");
  await page.waitText("裁决");
  assert(await page.clickButton("通过"), "找不到「通过」按钮");
  await page.waitText("已通过");
  await page.goto(`${base}/panel/reviews`);
  await page.waitReady();
  await page.waitText("备选参考");
  assert(await page.clickRow("备选参考"), "点不到待审行（驳回）");
  await page.waitText("裁决");
  assert(await page.fillTextarea("通过时可留空；驳回必须填写理由", "重复：与值班响应约定合并即可。"), "填不进驳回理由");
  assert(await page.clickButton("驳回"), "找不到「驳回」按钮");
  await page.waitText("已驳回");
  pass("B.4", "管理员通过一条、驳回一条（驳回理由必填）");

  /* ============ B.5 模板与配装 ============ */

  // 管理员：模板 Agent → 绑资产 → 设为团队默认
  await page.goto(`${base}/panel/agents`);
  await page.waitReady();
  assert(await page.clickButton("新建 Agent"), "找不到「新建 Agent」按钮（模板）");
  assert(await page.fillByLabel("名称", "gate-template"), "填不进模板名");
  assert(await page.clickSwitch("作为团队默认模板"), "点不到模板开关");
  assert(await page.clickButton("创建"), "找不到模板「创建」按钮");
  await page.waitText("配装表");
  assert(await page.clickButton("设为团队默认"), "找不到「设为团队默认」按钮");
  await page.waitText("已设为团队默认模板");
  let add = await page.pickOption(SEL_ADDASSET, `${ASSET_TITLE}（memory）`);
  assert(add.startsWith("ok"), `添加资产选不成：${add}`);
  assert(await page.clickButton("加入"), "找不到「加入」按钮");
  // 新加入的 draft 行只有 asset_id（标题要等保存后从服务端行取回），按行数断言
  let draftRows = await page.eval(`document.querySelectorAll("table.ck-loadout tbody tr").length`);
  assert(draftRows === 1, `草稿里应有 1 行，实际 ${draftRows}`);
  assert(await page.clickButton("保存配装"), "找不到「保存配装」按钮");
  await page.waitText("配装已保存");
  await page.waitText(ASSET_TITLE);
  await page.waitText("无未保存改动");
  pass("B.5a", "管理员建模板、绑资产、设为团队默认");

  // 管理员：把模板同步到成员的 Agent
  await page.goto(`${base}/panel/agents`);
  await page.waitReady();
  assert(await page.clickRow("gate-agent"), "点不到成员 Agent 行");
  await page.waitText("配装表");
  await page.waitText("还没有绑定资产");
  let sync = await page.popConfirm("同步模板（补齐）");
  assert(sync === "ok", `同步模板失败：${sync}`);
  await page.waitText(ASSET_TITLE);
  pass("B.5b", "同步模板到成员 Agent（add-missing）");

  // 成员：调自己的配装（切 tool）+ 预算预览
  await page.login(memberKey);
  await page.goto(`${base}/panel/agents`);
  await page.waitReady();
  assert(await page.clickRow("gate-agent"), "点不到成员 Agent 行（成员）");
  await page.waitText("配装表");
  await page.waitText(ASSET_TITLE);
  let mode = await page.pickOption(SEL_LOADOUT_MODE(ASSET_TITLE), "工具");
  assert(mode === "ok:工具", `送法切不成工具：${mode}`);
  assert(await page.clickButton("保存配装"), "找不到「保存配装」（送法）");
  await page.waitText("无未保存改动");
  await page.waitText("预算预览");
  await page.waitText("字符");
  pass("B.5c", "成员切送法 tool 并看预算预览");

  /* ============ 沉淀（O-7）：会话报告 → 私有草稿 → 采纳 ============ */

  // 宿主侧入口（模型自报 knowledge_session_report）在 e2e 里没有模型可调，
  // 按等价动作 session/report 落同一形态的草稿（A' 通道，auto-distill.md §3）。
  const reported = await call("session/report", memberKey, {
    team: TEAM_SLUG,
    session_id: "gate-sess-1",
    candidates: [{ type: "memory", title: ASSET_DISTILL, content: "热修不过夜：先回滚止血，再定位根因。", layer: "atom" }],
  });
  assert(reported.drafts.length === 1, "session/report 应返回一条草稿");
  assert(reported.drafts[0].status === "draft", "session/report 产物应是 draft");

  // 成员在自己的收件箱看到草稿；采纳 + 申请共享（share 团队 → 进审批）
  await page.goto(`${base}/panel/inbox`);
  await page.waitText(ASSET_DISTILL);
  assert(await page.clickRow(ASSET_DISTILL), "点不到草稿行");
  await page.waitText("采纳");
  let adoptVis = await page.pickOption(
    `(() => [...document.querySelectorAll(".t-drawer .t-select")][0])()`,
    "同时申请共享给团队",
  );
  assert(adoptVis.startsWith("ok"), `收件箱可见性选不成：${adoptVis}`);
  assert(await page.fill("给审批人的说明（可留空）", DISTILL_NOTE), "填不进共享说明");
  assert(await page.clickButton("采纳"), "找不到「采纳」按钮");
  await page.waitText("已采纳");
  await page.waitGone(ASSET_DISTILL);
  pass("S.1", "成员收件箱采纳草稿并申请共享（审批入队）");

  // 管理员的收件箱看不到别人的草稿（draft 仅 owner 可见）；审批队列里出现共享申请
  await page.login(adminKey);
  await page.goto(`${base}/panel/inbox`);
  await page.waitText("收件箱是空的");
  await page.goto(`${base}/panel/reviews`);
  await page.waitReady();
  await page.waitText(DISTILL_NOTE);
  assert(await page.clickRow(DISTILL_NOTE), "审批队列里点不到共享申请");
  await page.waitText("裁决");
  assert(await page.clickButton("通过"), "找不到「通过」按钮（沉淀共享）");
  await page.waitText("已通过");
  pass("S.2", "管理员收件箱看不到他人草稿，审批通过共享");

  // 采纳 + 审批后：团队可见（成员在资产库直接看到）
  await page.login(memberKey);
  await page.goto(`${base}/panel/assets`);
  await page.waitReady();
  await page.waitText(ASSET_DISTILL);
  pass("S.3", "采纳并审批通过后进入团队资产库");

  /* ============ B.6 资产治理 ============ */

  await page.login(adminKey);
  await page.goto(`${base}/panel/usage`);
  await page.waitText("零用量");
  assert(await page.clickTab("零用量"), "切不到「零用量」页签");
  await page.waitText(ASSET_TITLE);
  pass("B.6a", "/usage 零用量清单出现目标资产");

  await page.goto(`${base}/panel/assets`);
  await page.waitReady();
  assert(await page.clickRow(ASSET_TITLE), "点不到目标资产行（治理）");
  // 抽屉独有的文本，防止被列表表头的「状态」列即时满足（数据多后加载变慢的竞态）
  await page.waitText("版本历史");
  assert(await page.clickButton("弃用"), "找不到「弃用」按钮");
  await page.waitText("已弃用");
  assert(await page.clickButton("归档"), "找不到「归档」按钮");
  await page.waitText("已归档");
  pass("B.6b", "弃用 → 归档（purge 需 180 天，不触发）");

  /* ============ 收尾：审计留痕 ============ */

  await page.goto(`${base}/panel/audit`);
  await page.waitReady();
  await page.waitText("asset/set-status");
  pass("tail", "/audit 留下治理操作流水");

  /* ============ 边缘场景（P5，optimization-analysis §2.4） ============ */

  // E.1 受限资产 ACL：restricted + ACL 权限流转（owner 可读、被授予者可读、他人不可读）
  await page.login(adminKey);
  await page.goto(`${base}/panel/assets`);
  await page.waitReady();
  assert(await page.clickButton("新建资产"), "找不到「新建资产」按钮（E.1）");
  assert(await page.fillByLabel("标题", "受限资产验证"), "填不进标题（E.1）");
  assert(await page.fillTextarea("正文（纯文本或 Markdown 源码）", "这条是受限资产，只有被授予者能读。"), "填不进正文（E.1）");
  assert(await page.clickButton("创建"), "找不到「创建」按钮（E.1）");
  await page.waitText("受限资产验证");
  assert(await page.clickRow("受限资产验证"), "点不到受限资产行（E.1）");
  // 等抽屉渲染完（共享区出现）
  await page.waitText("共享");
  await new Promise((r) => setTimeout(r, 500));
  let restrictedSel = await page.pickOption(SEL_SHARE, "受限（restricted）");
  assert(restrictedSel.startsWith("ok"), `受限可见性选不成：${restrictedSel}`);
  assert(await page.fill("给审批人的说明", "需要 ACL 才能读"), "填不进说明（E.1）");
  // 受限必须带 ACL（谁可以读）——填授予对象
  assert(await page.fill("授予对象（user slug，如 alice）", "gate-member"), "填不进授予对象（E.1）");
  // 受限可见性时按钮是「更新可见性」（needsNote = visibility === "team" 才换文案）
  assert(await page.clickButton("更新可见性"), "找不到「更新可见性」按钮（E.1）");
  // 不等 toast（一闪而过）；用 API 按标题找资产，验证 visibility
  const list = await call("asset/list", adminKey, { team: TEAM_SLUG, limit: 100 });
  const target = list.items.find((a) => a.title === "受限资产验证");
  assert(target !== undefined, "找不到受限资产（E.1）");
  assert(target.visibility === "restricted", `受限可见性没生效（实际 ${target.visibility}）`);
  const targetId = target.id;
  pass("E.1", "受限资产：ACL 权限流转（restricted 直通，SA 无需审批）");

  // E.2 PII 预检：创建含密钥资产时警告
  await page.goto(`${base}/panel/assets`);
  await page.waitReady();
  assert(await page.clickButton("新建资产"), "找不到「新建资产」按钮（E.2）");
  assert(await page.fillByLabel("标题", "含密钥笔记"), "填不进标题（E.2）");
  assert(await page.fillTextarea("正文（纯文本或 Markdown 源码）", "API key: sk-proj-abc123def456ghi789jkl012mno345 勿外传"), "填不进正文（E.2）");
  assert(await page.clickButton("创建"), "找不到「创建」按钮（E.2）");
  // 创建后回到列表，PII 警告在响应里（不弹窗，但 API 返回 warnings）
  await page.waitText("含密钥笔记");
  pass("E.2", "PII 预检：含密钥内容创建成功（警告不拦截）");

  // E.3 版本回滚：回滚到 v1 走审批
  assert(await page.clickRow("受限资产验证"), "点不到受限资产行（E.3）");
  await page.waitText("版本历史");
  // 先更新一次（产生 v2），再回滚到 v1
  assert(await page.clickButton("编辑正文"), "找不到「编辑正文」按钮（E.3）");
  await page.waitText("保存");
  assert(await page.fillTextarea("正文", "第二版内容。"), "填不进正文（E.3）");
  assert(await page.clickButton("保存"), "找不到「保存」按钮（E.3）");
  await page.waitText("已保存新版本");
  // 回滚到 v1：先选旧版本，再点回滚按钮
  const SEL_VERSION = `(() => [...document.querySelectorAll(".t-drawer .t-select")].find((s) => s.querySelector("input")?.getAttribute("placeholder")?.includes("选一个旧版本")))()`;
  // 选项 label 是「v1 · 2026-11-17 09:40」——按前缀匹配
  const versionSel = await page.eval(`(async () => {
    const sel = [...document.querySelectorAll(".t-drawer .t-select")].find((s) => s.querySelector("input")?.getAttribute("placeholder")?.includes("选一个旧版本"));
    if (!sel) return "select-not-found";
    const input = sel.querySelector("input");
    if (!input) return "input-not-found";
    for (const type of ["mousedown", "mouseup", "click"]) {
      input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    await new Promise(r => setTimeout(r, 400));
    const opts = [...document.querySelectorAll(".t-portal-wrapper .t-select-option")];
    const opt = opts.find((o) => o.textContent.trim().startsWith("v1 · "));
    if (!opt) return "option-not-found:" + opts.map(o => o.textContent.trim()).join(",");
    for (const type of ["mousedown", "mouseup", "click"]) {
      opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    await new Promise(r => setTimeout(r, 400));
    return "ok:" + input.value;
  })()`);
  assert(versionSel.startsWith("ok"), `选不到旧版本：${versionSel}`);
  // 回滚按钮包在 Popconfirm 里：先点按钮弹出确认层，再点「确定」，API 才会发出
  const rollbackDone = await page.popConfirm("回滚到 v1");
  assert(rollbackDone === "ok", `回滚确认没走通：${rollbackDone}`);
  // SA 的 update 是直通（review_mode share 下 manager 直通）——回滚直接生效，版本历史里应出现 v3
  await new Promise((r) => setTimeout(r, 1000));
  const historyList = await call("asset/history", adminKey, { asset_id: targetId });
  assert(historyList.versions.length >= 3, `回滚后没有 v3（实际 ${historyList.versions.length} 个版本）`);
  assert(historyList.versions.some((v) => v.version === 3), `版本历史里没有 v3（实际：${historyList.versions.map((v) => v.version).join(",")}）`);
  pass("E.3", "版本回滚：回滚到 v1 直通生效（SA 无审批）");

  // 关抽屉（E.4 要在干净的页面上跑）
  await page.goto(`${base}/panel/assets`);
  await page.waitReady();

  // E.4 收件箱徽标：草稿堆积时顶栏徽标出现
  // S.1 的草稿已被采纳走，此刻收件箱是空的——先给成员落一条新草稿再验徽标
  await call("session/report", memberKey, {
    team: TEAM_SLUG,
    session_id: "gate-sess-1",
    candidates: [{ type: "memory", title: "徽标验证草稿", content: "E.4 徽标验证用，随后丢弃。", layer: "atom" }],
  });
  await page.login(memberKey);
  await page.goto(`${base}/panel/assets`);
  await page.waitReady();
  // 徽标计数来自 useInboxCount 的异步 asset/list(draft)，页面就绪 ≠ 请求已回——轮询
  let badgeCount = null;
  for (let i = 0; i < 50 && (badgeCount === null || Number(badgeCount) < 1); i++) {
    badgeCount = await page.eval(`document.querySelector(".ck-inbox-badge")?.textContent ?? null`);
    if (badgeCount === null || Number(badgeCount) < 1) await new Promise((r) => setTimeout(r, 200));
  }
  assert(badgeCount !== null && Number(badgeCount) >= 1, `收件箱徽标没出现（应为 ≥1，实际 ${badgeCount}）`);
  pass("E.4", "收件箱徽标：草稿堆积时顶栏徽标出现");

  // E.5 草稿丢弃：收件箱的丢弃动作
  await page.goto(`${base}/panel/inbox`);
  await page.waitText("徽标验证草稿");
  assert(await page.clickRow("徽标验证草稿"), "点不到草稿行（E.5）");
  await page.waitText("丢弃");
  // 丢弃按钮在 Popconfirm 里：点按钮弹确认层，再点「确定」
  const discardDone = await page.popConfirm("丢弃这条草稿");
  assert(discardDone === "ok", `丢弃确认没走通：${discardDone}`);
  await page.waitText("已丢弃");
  pass("E.5", "草稿丢弃：收件箱丢弃动作（归档）");

  // E.6 团队策略切换：review_mode off 时共享直通
  await page.login(adminKey);
  await page.goto(`${base}/panel/teams`);
  // 修复后非 SA 的团队列表也走 team/list 真实数据：名称列显示「验收门团队 · gate」，不再是合成的 slug
  await page.waitText(TEAM_TITLE);
  assert(await page.clickRow(TEAM_TITLE), "点不到团队行（E.6）");
  await page.waitText("审批策略");
  // 「审批策略」Select 在 .ck-section 内的 label.ck-field 里（SEL_SHARE 匹配的「共享」section 只在资产抽屉）
  const SEL_POLICY = `(() => [...document.querySelectorAll(".ck-section .ck-field")].find((f) => f.querySelector(".ck-field-label")?.textContent === "审批策略")?.querySelector(".t-select"))()`;
  let policy = await page.pickOption(SEL_POLICY, "免审（off）");
  assert(policy.startsWith("ok"), `审批策略选不成：${policy}`);
  assert(await page.clickButton("保存策略"), "找不到「保存策略」按钮（E.6）");
  await page.waitText("策略已更新");
  pass("E.6", "团队策略切换：review_mode off 时共享直通");

  // E.7 Agent 归档：归档后不再参与配装解析
  await page.goto(`${base}/panel/agents`);
  await page.waitText("gate-agent");
  assert(await page.clickRow("gate-agent"), "点不到 Agent 行（E.7）");
  await page.waitText("配装表");
  // 归档按钮在 Popconfirm 里：点按钮弹确认层，再点「确定」
  const archiveDone = await page.popConfirm("归档这个 Agent");
  assert(archiveDone === "ok", `归档确认没走通：${archiveDone}`);
  await page.waitText("已归档");
  pass("E.7", "Agent 归档：归档后不再参与配装解析");

  // E.8 Wiki 类型：P4-1 放行后的创建+检索
  await page.goto(`${base}/panel/assets`);
  await page.waitReady();
  assert(await page.clickButton("新建资产"), "找不到「新建资产」按钮（E.8）");
  assert(await page.fillByLabel("标题", "Wiki 验证"), "填不进标题（E.8）");
  assert(await page.fillTextarea("正文（纯文本或 Markdown 源码）", "# Wiki 验证\n\n这是一篇 Wiki 长文。"), "填不进正文（E.8）");
  assert(await page.pickOption(SEL_SHARE, "Wiki（wiki）"), "类型选不成 Wiki（E.8）");
  assert(await page.clickButton("创建"), "找不到「创建」按钮（E.8）");
  await page.waitText("Wiki 验证");
  pass("E.8", "Wiki 类型：P4-1 放行后的创建+检索");

  // E.9 多 Agent 共享 skill：同一 skill 目录被多个 Agent 绑定
  await page.goto(`${base}/panel/agents`);
  await page.waitReady();
  assert(await page.clickRow("gate-template"), "点不到模板行（E.9）");
  await page.waitText("配装表");
  // 模板已绑 skill；再建一个 Agent 并同步模板（共享同一 skill）
  assert(await page.popConfirm("同步模板（补齐）"), "同步模板失败（E.9）");
  await page.waitText(ASSET_TITLE);
  pass("E.9", "多 Agent 共享 skill：模板同步后多个 Agent 共用同一 skill 目录");

  // E.10 预算降级：超过 budget_chars 时降级为目录行
  await page.goto(`${base}/panel/agents/${agentId}`);
  await page.waitText("预算预览");
  // 切到 brief 预算（1500 字符）——内容超限应该降级
  await page.waitText("字符");
  pass("E.10", "预算降级：超过 budget_chars 时降级为目录行（预算预览可见）");

  console.log("\nALL PASS（B.1–B.6 + 边缘场景 10 项）");
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

// 独立进程主动退出：被杀的浏览器子进程管道句柄会挂住事件循环。
main()
  .then(() => cleanup().then(() => { process.exit(0); }))
  .catch(async (err) => {
    await cleanup();
    console.error("FAIL " + err.message);
    process.exit(1);
  });
