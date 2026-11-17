import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A.2 十步读档验收门（docs/sop.md §A.2）。
 * 起临时 hub（临时 dataDir + 空闲端口，跑完整个目录删掉），全程只走 HTTP 公开接口。
 * 用法：pnpm e2e   （需先 pnpm build）
 * 约定：key 只在进程内传递，输出只打前缀；任何一步失败即以退出码 1 结束，并在 finally 里清场。
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_BIN = join(REPO, "packages", "hub", "lib", "bin.js");

const mask = (key) => `${key.slice(0, 11)}…`;
const results = [];

function step(n, title, extra = "") {
  results.push({ n, title });
  console.log(`PASS ${n} ${title}${extra ? `（${extra}）` : ""}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

const dir = mkdtempSync(join(tmpdir(), "ck-e2e-"));
let hub = null;

async function main() {
  assert(existsSync(HUB_BIN), `hub 构建产物不存在：${HUB_BIN}（先 pnpm build）`);
  const port = await freePort();
  const configFile = join(dir, "hub.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      dataDir: join(dir, "data"),
      listen: { host: "127.0.0.1", port, allowedOrigins: [] },
      limits: { maxBodyBytes: 8388608, maxContentBytes: 262144, maxFileBytes: 5242880 },
      log: { level: "error" },
    }),
  );

  // 1. bootstrap → 建团队 demo → 建用户 A（admin）、B（member）并发 key
  const boot = await run([HUB_BIN, "bootstrap", "--config", configFile, "--name", "root"]);
  assert(boot.code === 0, `bootstrap 失败：${boot.err.trim()}`);
  const rootKey = JSON.parse(boot.out).key;

  hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  hub.stderr.on("data", (d) => process.stderr.write(`[hub] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert(up, "hub 未能在 10 秒内就绪");

  async function call(action, key, body = {}) {
    const res = await fetch(`${base}/api/v1/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, env: await res.json() };
  }
  async function ok(action, key, body = {}) {
    const r = await call(action, key, body);
    assert(r.status === 200 && r.env.code === 0, `${action} 失败：${r.status} ${JSON.stringify(r.env)}`);
    return r.env.data;
  }
  async function fails(action, key, body, wantCode, wantStatus) {
    const r = await call(action, key, body);
    assert(r.status === wantStatus, `${action} 期望 HTTP ${wantStatus}，实际 ${r.status}：${JSON.stringify(r.env)}`);
    // 信封：code 是数值状态，message 才是枚举
    assert(r.env.message === wantCode, `${action} 期望 message=${wantCode}，实际 ${r.env.message}`);
    return r.env;
  }

  const team = await ok("team/create", rootKey, { name: "demo", title: "Demo" });
  const teamId = team.team.id;
  const a = await ok("user/create-with-key", rootKey, { name: "alice", display_name: "Alice", key_name: "e2e", is_system_admin: true });
  const b = await ok("user/create-with-key", rootKey, { name: "bob", display_name: "Bob", key_name: "e2e" });
  const aKey = a.key.key;
  const bKey = b.key.key;
  await ok("team-member/add", rootKey, { team_id: teamId, user_id: a.user.id, role: "admin" });
  await ok("team-member/add", rootKey, { team_id: teamId, user_id: b.user.id, role: "member" });
  step(1, "bootstrap + 团队 demo + 用户 A/B 发 key", `A=${mask(aKey)} B=${mask(bKey)}`);

  // 2. A 建记忆 M1 → 共享到团队（自批生效）；建 skill S1 → 共享
  const m1 = await ok("asset/create", aKey, {
    team_id: teamId,
    type: "memory",
    title: "E2E 发布约定",
    content: "发布前先跑 e2e，读档脚本必须绿。",
  });
  const m1Id = m1.asset.id;
  const m1Shared = await ok("asset/set-visibility", aKey, { asset_id: m1Id, visibility: "team" });
  assert(m1Shared.status === "applied", `M1 共享应自批生效，实际 ${JSON.stringify(m1Shared)}`);

  const s1 = await ok("asset/create", aKey, {
    team_id: teamId,
    type: "skill",
    name: "e2e-deploy",
    title: "E2E 发版",
    content: "---\nname: e2e-deploy\ndescription: 读档验收用的发版流程\n---\n\n1. 构建\n2. 跑 e2e\n3. 切流量",
  });
  const s1Id = s1.asset.id;
  const s1Shared = await ok("asset/set-visibility", aKey, { asset_id: s1Id, visibility: "team" });
  assert(s1Shared.status === "applied", `S1 共享应自批生效，实际 ${JSON.stringify(s1Shared)}`);
  step(2, "A 建 M1 并共享（自批），建 skill S1 并共享");

  // 3. A 建模板 Agent，绑定 M1（inject）与 S1（inject），设为团队默认模板
  const tpl = await ok("agent/create", aKey, { team_id: teamId, name: "e2e-template", host: "claude-code", is_template: true });
  const tplId = tpl.agent.id;
  for (const [i, asset_id] of [m1Id, s1Id].entries()) {
    const bound = await ok("loadout/bind", aKey, { agent_id: tplId, asset_id, priority: (i + 1) * 10, injection_mode: "inject" });
    assert(bound.binding.injection_mode === "inject", `绑定模式应为 inject：${JSON.stringify(bound)}`);
  }
  await ok("agent/set-default-template", aKey, { team_id: teamId, agent_id: tplId });
  step(3, "模板 Agent 绑定 M1/S1（inject）并设为团队默认模板");

  // 4. B agent/ensure → created = true，template_applied = 2
  const ensured = await ok("agent/ensure", bKey, { team: "demo", name: "bob-cc", host: "claude-code" });
  assert(ensured.created === true, `ensure 应返回 created=true：${JSON.stringify(ensured)}`);
  assert(ensured.template_applied === 2, `template_applied 应为 2，实际 ${ensured.template_applied}`);
  const agentId = ensured.agent.id;
  const again = await ok("agent/ensure", bKey, { team: "demo", name: "bob-cc", host: "claude-code" });
  assert(again.created === false && again.template_applied === 0, `二次 ensure 应 created=false/0：${JSON.stringify(again)}`);
  step(4, "B agent/ensure → created=true，template_applied=2", "again created=false");

  // 5. B loadout/resolve → text 含 M1 标题；skills[] 含 S1；digest 稳定；bytes ≤ max_bytes
  const maxBytes = 20000;
  const first = await ok("loadout/resolve", bKey, { agent_id: agentId, max_bytes: maxBytes });
  assert(first.text.includes("E2E 发布约定"), "resolve 文本里没有 M1 标题");
  assert(
    Array.isArray(first.skills) && first.skills.some((s) => s.name === "e2e-deploy"),
    `skills[] 里没有 S1：${JSON.stringify(first.skills)}`,
  );
  assert(first.bytes <= maxBytes, `bytes ${first.bytes} 超过 max_bytes ${maxBytes}`);
  assert(/^[0-9a-f]{64}$/.test(first.digest), `digest 不是 sha256：${first.digest}`);
  const second = await ok("loadout/resolve", bKey, { agent_id: agentId, max_bytes: maxBytes });
  assert(second.digest === first.digest, `两次 resolve 的 digest 不稳定：${first.digest} vs ${second.digest}`);
  const unchanged = await ok("loadout/resolve", bKey, { agent_id: agentId, max_bytes: maxBytes, if_digest: first.digest });
  assert(unchanged.not_modified === true && unchanged.text === "", "if_digest 命中时应返回 not_modified 且无正文");
  step(5, "B resolve：含 M1 标题、S1 在 skills[]、digest 稳定、bytes 合规", `${first.bytes}B / ${first.digest.slice(0, 12)}…`);

  // 6. B 建私有记忆 M2 → A asset/search 搜不到；A asset/get M2 → NOT_FOUND
  const m2 = await ok("asset/create", bKey, {
    team_id: teamId,
    type: "memory",
    title: "B 的私有记录",
    content: "private-only 内容，共享前任何人都看不到。",
  });
  const m2Id = m2.asset.id;
  const missA = await ok("asset/search", aKey, { query: "B 的私有记录" });
  assert(!missA.hits.some((h) => h.asset_id === m2Id), "A 不应搜到 B 的私有记忆");
  await fails("asset/get", aKey, { asset_id: m2Id }, "NOT_FOUND", 404);
  step(6, "B 建私有 M2：A 搜不到、get 返回 404 NOT_FOUND");

  // 7. B asset/set-visibility M2 → pending_review；A 仍搜不到
  const asked = await ok("asset/set-visibility", bKey, { asset_id: m2Id, visibility: "team", note: "e2e: 共享给团队" });
  assert(asked.status === "pending_review" && typeof asked.review_id === "string", `M2 提升应进审批：${JSON.stringify(asked)}`);
  const reviewId = asked.review_id;
  const stillMissA = await ok("asset/search", aKey, { query: "B 的私有记录" });
  assert(!stillMissA.hits.some((h) => h.asset_id === m2Id), "审批未决前 A 不应搜到 M2");
  step(7, "B 提升 M2 为 team → pending_review，A 仍搜不到");

  // 8. A review/decide approve → A 搜得到 M2
  const approved = await ok("review/decide", aKey, { review_id: reviewId, decision: "approve" });
  assert(approved.review.status === "approved", `approve 后 review 应为 approved：${JSON.stringify(approved)}`);
  assert(approved.review.note === "e2e: 共享给团队", `审批单应保留申请说明，实际 ${JSON.stringify(approved.review.note)}`);
  const foundA = await ok("asset/search", aKey, { query: "B 的私有记录" });
  assert(foundA.hits.some((h) => h.asset_id === m2Id), "approve 后 A 应搜得到 M2");
  step(8, "A approve → A 搜得到 M2", "note 已入审批单");

  // 9. B 对 M1 提议修改（base_version = 当前版本）→ pending_review；A reject 不带 reason → REASON_REQUIRED；
  //    B 再用过期的 base_version 提交 → VERSION_CONFLICT
  const proposal = await ok("asset/update", bKey, {
    asset_id: m1Id,
    base_version: 1,
    content: "发布前先跑 e2e，读档脚本必须绿（B 提议的措辞）。",
  });
  assert(proposal.status === "pending_review" && proposal.proposed_version === 2, `提议应 pending：${JSON.stringify(proposal)}`);
  await fails("review/decide", aKey, { review_id: proposal.review_id, decision: "reject" }, "REASON_REQUIRED", 400);
  await ok("review/decide", aKey, { review_id: proposal.review_id, decision: "reject", reason: "措辞不合适" });

  // 让版本真的走一格：A 作为管理者直通更新（被驳回的提议占着 v2，直通落到 v3）
  const bumped = await ok("asset/update", aKey, { asset_id: m1Id, base_version: 1, content: "发布前先跑 e2e，读档脚本必须绿（v2）。" });
  assert(bumped.changed === true && bumped.version > proposal.proposed_version, `A 直通更新应推进版本：${JSON.stringify(bumped)}`);
  const nowVersion = bumped.version;
  const stale = await fails(
    "asset/update",
    bKey,
    { asset_id: m1Id, base_version: 1, content: "基于过期版本的修改" },
    "VERSION_CONFLICT",
    409,
  );
  assert(stale.data.current_version === nowVersion, `VERSION_CONFLICT 应带 current_version=${nowVersion}：${JSON.stringify(stale.data)}`);
  step(9, "B 提议进审批；reject 缺 reason → REASON_REQUIRED；过期 base_version → VERSION_CONFLICT");

  // 10. A 吊销 B 的 key → B 任意调用 401
  const keys = await ok("user-key/list", bKey, {});
  // key 形状 ck_<prefix>_<secret>，库里只存 prefix（8 hex）
  const bKeyRow = keys.keys.find((k) => k.revoked_at === null && k.prefix === bKey.slice(3, 11));
  assert(bKeyRow !== undefined, `找不到 B 的 key：${JSON.stringify(keys.keys)}`);
  await ok("user-key/revoke", aKey, { user_id: b.user.id, key_id: bKeyRow.id });
  await fails("auth/verify", bKey, {}, "UNAUTHORIZED", 401);
  step(10, "A 吊销 B 的 key → B 调用 401 UNAUTHORIZED");
}

main()
  .then(() => {
    console.log(`\nTotal ${results.length}, Pass ${results.length}, Fail 0`);
  })
  .catch((err) => {
    const done = results.length;
    console.log(`\nTotal 10, Pass ${done}, Fail ${10 - done}`);
    console.error(`FAIL 第 ${done + 1} 步：${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (hub && hub.exitCode === null) hub.kill();
    // Windows 上 sqlite 句柄偶尔晚一拍才释放：带重试删目录，删不掉只提示
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (err) {
        console.error(`临时目录未删净：${dir}（${err.message}）`);
      }
    }, 300);
  });
