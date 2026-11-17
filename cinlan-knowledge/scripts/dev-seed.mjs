// 起 dev hub（临时库，不碰仓库 data/）+ 种真实感数据，打印 key，前台运行。
// 用法：node scripts/dev-seed.mjs（Ctrl+C 退出即清库）。
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HUB_BIN = join(REPO, "packages/hub/lib/bin.js");
const PORT = 8424;
const dir = mkdtempSync(join(tmpdir(), "ck-dev-"));
const configFile = join(dir, "hub.json");
const dataDir = join(dir, "data");
mkdirSync(dataDir, { recursive: true });
writeFileSync(configFile, JSON.stringify({
  dataDir,
  listen: { host: "127.0.0.1", port: PORT, allowedOrigins: ["http://127.0.0.1:8424"] },
  limits: { maxBodyBytes: 8388608, maxContentBytes: 262144, maxFileBytes: 5242880 },
  log: { level: "error" },
}, null, 2));

const boot = spawnSync(process.execPath, [HUB_BIN, "bootstrap", "--config", configFile, "--name", "root"], { encoding: "utf8" });
if (boot.status !== 0) throw new Error(`bootstrap: ${boot.stderr}`);
const saKey = JSON.parse(boot.stdout.slice(boot.stdout.indexOf("{"))).key;

const hub = spawn(process.execPath, [HUB_BIN, "serve", "--config", configFile], { stdio: ["ignore", "ignore", "ignore"] });
const base = `http://127.0.0.1:${PORT}`;
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

const team = await call("team/create", saKey, { name: "cinlan", title: "Cinlan 研发" });
const ly = await call("user/create-with-key", saKey, { name: "ly", display_name: "LY", key_name: "ly-macbook" });
await call("team-member/add", saKey, { team_id: team.team.id, user_id: ly.user.id, role: "admin" });
const lyKey = ly.key.key;
const shiyi = await call("user/create-with-key", saKey, { name: "shiyi", display_name: "十一", key_name: "shiyi-thinkpad" });
await call("team-member/add", saKey, { team_id: team.team.id, user_id: shiyi.user.id, role: "member" });
const shiyiKey = shiyi.key.key;

const memories = [
  ["发版检查清单", "发布前先跑 pnpm -r test，再翻 releases/current symlink；回滚 = symlink 翻回上一版。\n热修不过夜：先止血（回滚），再定位。", "team", "core"],
  ["值班响应约定", "夜间 P0 告警先看 hub 日志与 /healthz，再拉人；十分钟内必须有响应记录。", "team", "profile"],
  ["接口错误码总表", "0 INTERNAL / 401 UNAUTHORIZED / 403 FORBIDDEN / 404 NOT_FOUND / 409 VERSION_CONFLICT / 429 RATE_LIMITED。", "team", "core"],
  ["旧认证模块禁区", "不要重构 legacy auth，移动端仍在用；改动前先找 LY 确认。", "team", "atom"],
  ["个人速记：codex 走查口径", "换 --agent 重跑不再是冲突——条目归 ck 所有，原地更新。", "private", "atom"],
  ["客户交付话术 v2", "第一句先讲结论，再给证据路径；不要先铺方法论。", "team", "profile"],
];
for (const [title, content, visibility, layer] of memories) {
  const a = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title, content, layer });
  if (visibility !== "private") await call("asset/set-visibility", lyKey, { asset_id: a.asset.id, visibility });
}
const restricted = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title: "客户交付话术 v2（脱敏稿）", content: "第一句先讲结论，再给证据路径。", layer: "profile" });
await call("asset/set-visibility", lyKey, { asset_id: restricted.asset.id, visibility: "restricted", acl: [{ subject_type: "user", subject_id: shiyi.user.id, permission: "read" }] });

const skill = await call("asset/create", lyKey, {
  team_id: team.team.id,
  type: "skill",
  name: "deploy-release",
  title: "发版与回滚操作步骤",
  content: "---\nname: deploy-release\ndescription: 发版与回滚的操作步骤\n---\n\n# Deploy\n\n1. pnpm -r test\n2. 打 tag\n3. 翻 symlink current\n4. 观察五分钟",
});
await call("asset/set-visibility", lyKey, { asset_id: skill.asset.id, visibility: "team" });

const old = await call("asset/create", lyKey, { team_id: team.team.id, type: "memory", title: "旧版部署流程（已废弃）", content: "旧流程：手动 scp。已被 deploy-release 取代。", layer: "profile" });
await call("asset/set-visibility", lyKey, { asset_id: old.asset.id, visibility: "team" });
await call("asset/set-status", lyKey, { asset_id: old.asset.id, action: "deprecate", note: "已被 deploy-release 取代" });

const pending = await call("asset/create", shiyiKey, { team_id: team.team.id, type: "memory", title: "Code Review 惯例", content: "PR 描述里带复现步骤；超过 400 行先拆。" });
await call("asset/set-visibility", shiyiKey, { asset_id: pending.asset.id, visibility: "team", note: "团队新人都在问，建议进全员上下文" });

const tpl = await call("agent/create", lyKey, { team_id: team.team.id, name: "template-default", host: "dsh", is_template: true });
const checklist = (await call("asset/search", lyKey, { query: "发版检查清单", team: "cinlan" })).hits[0].asset_id;
await call("loadout/bind", lyKey, { agent_id: tpl.agent.id, asset_id: checklist, priority: 0, injection_mode: "inject" });
await call("loadout/bind", lyKey, { agent_id: tpl.agent.id, asset_id: skill.asset.id, priority: 10, injection_mode: "inject" });
const errTable = (await call("asset/search", lyKey, { query: "接口错误码总表", team: "cinlan" })).hits[0].asset_id;
await call("loadout/bind", lyKey, { agent_id: tpl.agent.id, asset_id: errTable, priority: 20, injection_mode: "tool" });
await call("agent/set-default-template", lyKey, { team_id: team.team.id, agent_id: tpl.agent.id });

const agent = await call("agent/ensure", lyKey, { team: "cinlan", name: "dsh-ly", host: "dsh" });
for (let i = 0; i < 6; i++) {
  await call("usage/report", lyKey, { agent_id: agent.agent.id, events: [{ asset_id: checklist, version: 1, kind: "injected" }] });
}
await call("usage/report", lyKey, { agent_id: agent.agent.id, events: [{ asset_id: checklist, version: 1, kind: "opened" }] });
await call("usage/report", lyKey, { agent_id: agent.agent.id, events: [{ asset_id: skill.asset.id, version: 1, kind: "opened" }] });

process.stdout.write([
  "",
  `panel:  ${base}/panel/`,
  `login key (LY, 管理员):  ${lyKey}`,
  `login key (十一, member):  ${shiyiKey}`,
  "",
  "Ctrl+C 退出并清库。",
  "",
].join("\n"));

process.on("SIGINT", () => { hub.kill(); process.exit(0); });
process.on("SIGTERM", () => { hub.kill(); process.exit(0); });
