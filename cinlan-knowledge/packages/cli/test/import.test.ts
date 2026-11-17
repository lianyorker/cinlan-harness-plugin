import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandScanDirs, parseFrontmatter, parseSelection, runImport, scanSkills } from "../src/import.js";
import { hubFetch } from "./support.js";

const SKILL = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# body\n`;

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ck-import-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeSkill(root: string, dirName: string, skillMd: string | null, files: Record<string, string> = {}): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  if (skillMd !== null) writeFileSync(join(dir, "SKILL.md"), skillMd);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

const CFG = { hub: "http://hub.test", key: "ck_test", sources: { hub: "env" as const, key: "env" as const } };
const VERIFY_ONE = { data: { teams: [{ team_id: "tem_1", team: "acme", role: "admin" }] } };
const IMPORT_OK = { data: { status: "created", asset: { id: "ast_1", name: "s", title: "s", version: 1, content_hash: "h", visibility: "private", status: "active", updated_at: "" } } };

// ------------------------------------------------------------------ 纯函数

test("expandScanDirs: ~、<workspace>、$VAR 展开；缺失目录记 note", () => {
  const { dir, cleanup } = tempDir();
  try {
    const skills = join(dir, "skills");
    mkdirSync(skills);
    const ws = join(dir, "ws");
    mkdirSync(join(ws, ".claude", "skills"), { recursive: true });
    const out = expandScanDirs(["~/skills", "<workspace>/.claude/skills", "$NOPE/skills", "<workspace>/missing"], {
      workspace: ws,
      home: dir,
      env: { NOPE: "" },
    });
    assert.deepEqual(out.dirs.sort(), [skills, join(ws, ".claude", "skills")].sort());
    assert.equal(out.notes.length, 2);
    assert.match(out.notes.join(" "), /\$NOPE 未设置/);
    assert.match(out.notes.join(" "), /目录不存在/);
  } finally {
    cleanup();
  }
});

test("expandScanDirs: %VAR%（hermes 的 win32 路径）展开；未设置记 note", () => {
  const { dir, cleanup } = tempDir();
  try {
    const skills = join(dir, "hermes", "skills");
    mkdirSync(skills, { recursive: true });
    const out = expandScanDirs(["%CK_T_LOCAL%/hermes/skills", "%CK_T_NOPE%/hermes/skills"], {
      workspace: dir,
      home: dir,
      env: { CK_T_LOCAL: dir },
    });
    assert.deepEqual(out.dirs, [skills]);
    assert.deepEqual(out.notes, ["%CK_T_NOPE%/hermes/skills → 跳过（%CK_T_NOPE% 未设置）"]);
  } finally {
    cleanup();
  }
});

test("parseFrontmatter: 正常块 / 引号 / 缺围栏 / 缺 description", () => {
  assert.deepEqual(parseFrontmatter(SKILL("a", "b")), { name: "a", description: "b" });
  assert.deepEqual(parseFrontmatter('---\nname: "x y"\ndescription: \'d\'\n---\n'), { name: "x y", description: "d" });
  assert.equal(parseFrontmatter("# no fence"), null);
  assert.equal(parseFrontmatter("---\nname: a\n"), null); // 没有结束围栏
  assert.deepEqual(parseFrontmatter("---\nname: a\n---\n"), { name: "a", description: undefined });
});

test("parseFrontmatter: 逐行解析，空值不借下一行；CRLF 同样认", () => {
  assert.deepEqual(parseFrontmatter("---\ndescription:\nname: a\n---\n"), { name: "a", description: "" });
  assert.deepEqual(parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\n"), { name: "a", description: "b" });
});

test("parseFrontmatter: 块标量——`>` 折叠、`|` 保留换行、空块读成空串；与 core 同读法", () => {
  const folded = "---\nname: a\ndescription: >-\n  Use when shipping\n  a release.\n\n  Second paragraph.\nlicense: MIT\n---\n# body\n";
  assert.deepEqual(parseFrontmatter(folded), { name: "a", description: "Use when shipping a release.\nSecond paragraph." });
  assert.deepEqual(parseFrontmatter(folded.replaceAll("\n", "\r\n")), parseFrontmatter(folded));
  assert.equal(parseFrontmatter(folded.replace(">-", ">"))!.description, "Use when shipping a release.\nSecond paragraph.");
  assert.equal(
    parseFrontmatter("---\nname: a\ndescription: |\n  line one\n    indented\n  line two\n---\n")!.description,
    "line one\n  indented\nline two",
  );
  assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: >-\n---\n"), { name: "a", description: "" });
  assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: >-\nlicense: MIT\n---\n"), { name: "a", description: "" });
});

test("scanSkills: 折叠标量的 description 取真实文本做摘要；空块按坏 frontmatter 跳过", () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "folded", "---\nname: folded-skill\ndescription: >-\n  Use when shipping\n  a release.\n---\n# body\n", {});
    makeSkill(dir, "emptyblock", "---\nname: emptyblock\ndescription: >-\n---\nbody\n", {});
    const { candidates, skipped } = scanSkills([dir]);
    assert.deepEqual(candidates.map((c) => [c.name, c.summary]), [["folded-skill", "Use when shipping a release."]]);
    assert.deepEqual(skipped.map((s) => [s.dir.replace(/^.*[\\/]/, ""), s.reason]), [["emptyblock", "bad-frontmatter"]]);
  } finally {
    cleanup();
  }
});

test("parseSelection: all/none/序号/区间/非法", () => {
  assert.equal(parseSelection("a", 3), "all");
  assert.equal(parseSelection("", 3), "none");
  assert.equal(parseSelection("s", 3), "none");
  assert.deepEqual(parseSelection("1,3", 3), [0, 2]);
  assert.deepEqual(parseSelection("1-3", 3), [0, 1, 2]);
  assert.deepEqual(parseSelection("2, 3-3", 3), [1, 2]);
  assert.equal(parseSelection("0", 3), null);
  assert.equal(parseSelection("4", 3), null);
  assert.equal(parseSelection("3-1", 3), null);
  assert.equal(parseSelection("x", 3), null);
});

test("scanSkills: 候选 / 物化标记 / 坏 frontmatter / 同名去重 / 附属文件", () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "good", SKILL("good-skill", "a good one"), { "extra.txt": "hello" });
    writeFileSync(join(dir, "good", "bin.dat"), Buffer.from([0xff, 0x01]));
    makeSkill(dir, "marked", SKILL("marked-skill", "x"), {});
    writeFileSync(join(dir, "marked", ".cinlan-knowledge.json"), "{}");
    makeSkill(dir, "nofm", "# just markdown\n", {});
    makeSkill(dir, "nodesc", "---\nname: nodesc\n---\nbody\n", {});
    makeSkill(dir, "emptydesc", "---\ndescription:\nname: emptydesc\n---\nbody\n", {});
    makeSkill(dir, "badname", SKILL("Bad Name", "d"), {});
    makeSkill(dir, "not-skill", null, { "readme.md": "x" }); // 无 SKILL.md，静默跳过
    const dir2 = mkdtempSync(join(tmpdir(), "ck-import2-"));
    makeSkill(dir2, "dup", SKILL("good-skill", "other"), {});
    const { candidates, skipped } = scanSkills([dir, dir2]);
    rmSync(dir2, { recursive: true, force: true });

    assert.equal(candidates.length, 1);
    const c = candidates[0]!;
    assert.equal(c.name, "good-skill");
    assert.equal(c.title, "good-skill");
    assert.equal(c.summary, "a good one");
    assert.match(c.content, /# body/);
    assert.equal(c.files.length, 2);
    assert.equal(c.files.find((f) => f.path === "extra.txt")?.encoding, "utf8");
    assert.equal(c.files.find((f) => f.path === "bin.dat")?.encoding, "base64");

    const reasons = Object.fromEntries(skipped.map((s) => [s.dir.replace(/^.*[\\/]/, ""), s.reason]));
    assert.equal(reasons["marked"], "externalized");
    assert.equal(reasons["nofm"], "bad-frontmatter");
    assert.equal(reasons["nodesc"], "bad-frontmatter");
    assert.equal(reasons["emptydesc"], "bad-frontmatter"); // hub 也不收：放过去就成了 failed
    assert.equal(reasons["badname"], "bad-frontmatter");
    assert.equal(reasons["dup"], "duplicate");
    assert.equal(reasons["not-skill"], undefined);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ runImport

const HOST = {
  name: "claude-code",
  title: "Claude Code",
  mcp: { file: "~/.claude.json", format: "json" as const, key: "mcpServers.ck", insert: false },
  hook: null,
  instructions: "brief" as const,
  budgets: {},
  skill_dir: "~/.claude/skills",
  import_scan: ["<scan>"],
};

function lines(): { out: (l: string) => void; text: () => string } {
  const buf: string[] = [];
  return { out: (l) => buf.push(l), text: () => buf.join("\n") };
}

test("runImport --dry-run：只列候选，不发任何请求", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    const { fetchImpl, calls } = hubFetch(() => IMPORT_OK);
    const io = lines();
    const report = await runImport({
      config: CFG,
      host: { ...HOST, import_scan: [dir] },
      dryRun: true,
      fetchImpl,
      out: io.out,
    });
    assert.equal(report.total, 1);
    assert.equal(calls.length, 0);
    assert.match(io.text(), /dry run: 1 candidate/);
  } finally {
    cleanup();
  }
});

test("runImport：唯一团队自动选，逐条提交 asset/import", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const d1 = makeSkill(dir, "s1", SKILL("s-one", "d1"), { "a.txt": "x" });
    makeSkill(dir, "s2", SKILL("s-two", "d2"));
    const { fetchImpl, calls } = hubFetch((action) => (action === "auth/verify" ? VERIFY_ONE : IMPORT_OK));
    const io = lines();
    const report = await runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, yes: true, fetchImpl, out: io.out });
    assert.equal(report.team, "acme");
    assert.equal(report.success, 2);
    assert.equal(report.failed, 0);
    const imports = calls.filter((c) => c.action === "asset/import");
    assert.equal(imports.length, 2);
    assert.equal(imports[0]!.body["team"], "acme");
    assert.equal(imports[0]!.body["name"], "s-one");
    assert.equal(imports[0]!.body["title"], "s-one");
    assert.equal(imports[0]!.body["host"], "claude-code");
    assert.equal(imports[0]!.body["import_path"], d1);
    assert.equal(imports[0]!.body["on_conflict"], undefined);
    assert.equal((imports[0]!.body["files"] as { path: string }[])[0]!.path, "a.txt");
  } finally {
    cleanup();
  }
});

test("runImport：多团队必须 --team；--team 非成员报错；唯一团队给了 --team 也用", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    const multi = { data: { teams: [{ team_id: "t1", team: "a" }, { team_id: "t2", team: "b" }] } };
    const { fetchImpl } = hubFetch((action) => (action === "auth/verify" ? multi : IMPORT_OK));
    await assert.rejects(
      () => runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, yes: true, fetchImpl, out: lines().out }),
      /--team <slug> 指定/,
    );
    const { fetchImpl: f2, calls } = hubFetch((action) => (action === "auth/verify" ? multi : IMPORT_OK));
    const report = await runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, team: "b", yes: true, fetchImpl: f2, out: lines().out });
    assert.equal(report.team, "b");
    assert.equal(calls.find((c) => c.action === "asset/import")!.body["team"], "b");
    await assert.rejects(
      () => runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, team: "zzz", yes: true, fetchImpl, out: lines().out }),
      /不是你的团队/,
    );
  } finally {
    cleanup();
  }
});

test("runImport：conflict 无 --update → skipped；带 --update 传 on_conflict；审批拒绝 → failed", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    const conflict = { data: { status: "conflict", asset: IMPORT_OK.data.asset } };
    const { fetchImpl } = hubFetch((action) => (action === "auth/verify" ? VERIFY_ONE : conflict));
    const io = lines();
    const r1 = await runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, yes: true, fetchImpl, out: io.out });
    assert.equal(r1.skipped, 1);
    assert.equal(r1.items[0]!.status, "conflict");
    assert.match(io.text(), /--update/);

    const { fetchImpl: f2, calls: c2 } = hubFetch((action) => (action === "auth/verify" ? VERIFY_ONE : conflict));
    const r2 = await runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, yes: true, update: true, fetchImpl: f2, out: lines().out });
    assert.equal(c2.find((c) => c.action === "asset/import")!.body["on_conflict"], "new_version");
    assert.equal(r2.failed, 1);
    assert.equal(r2.items[0]!.status, "conflict-under-review-mode");
  } finally {
    cleanup();
  }
});

test("runImport：unchanged 计 success；网络错误退避重试 3 次后 failed；非 0 码直接 failed", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    makeSkill(dir, "s2", SKILL("s-two", "d2"));
    makeSkill(dir, "s3", SKILL("s-three", "d3"));
    let attempts = 0;
    const { fetchImpl } = hubFetch((action, body) => {
      if (action === "auth/verify") return VERIFY_ONE;
      if (body["name"] === "s-one") return { data: { ...IMPORT_OK.data, status: "unchanged" } };
      if (body["name"] === "s-two") {
        attempts++;
        return "network";
      }
      return { code: 403, message: "FORBIDDEN" };
    });
    const sleeps: number[] = [];
    const report = await runImport({
      config: CFG,
      host: { ...HOST, import_scan: [dir] },
      yes: true,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      out: lines().out,
    });
    assert.equal(report.success, 1);
    assert.equal(report.failed, 2);
    assert.equal(attempts, 3); // 网络重试 3 次才放弃
    // 条目间隔 100ms；s-two 的两次退避夹在中间
    assert.deepEqual(sleeps, [100, 1000, 2000, 100]);
    assert.equal(report.items.find((i) => i.name === "s-two")!.status, "UNAVAILABLE");
    const forbidden = report.items.find((i) => i.name === "s-three")!;
    assert.equal(forbidden.status, "FORBIDDEN");
    assert.equal(forbidden.detail, undefined); // hub 没给说明时不重复打错误码
  } finally {
    cleanup();
  }
});

test("runImport：429 按 retry_after 等待后重试；一直 429 以 RATE_LIMITED 记 failed", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    makeSkill(dir, "s2", SKILL("s-two", "d2"));
    const limited = { code: 429, message: "RATE_LIMITED", data: { detail: "rate limit exceeded", retry_after: 3 } };
    let first = 0;
    const { fetchImpl, calls } = hubFetch((action, body) => {
      if (action === "auth/verify") return VERIFY_ONE;
      if (body["name"] === "s-one") return ++first === 1 ? limited : IMPORT_OK;
      return limited;
    });
    const sleeps: number[] = [];
    const report = await runImport({
      config: CFG,
      host: { ...HOST, import_scan: [dir] },
      yes: true,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      out: lines().out,
    });
    assert.equal(report.success, 1);
    assert.equal(report.failed, 1);
    // s-one：429 → 等 retry_after（3s，比退避长）→ 成功；条目间隔；s-two：三次都 429
    assert.deepEqual(sleeps, [3000, 100, 3000, 3000]);
    assert.equal(calls.filter((c) => c.action === "asset/import").length, 5);
    const failed = report.items.find((i) => i.name === "s-two")!;
    assert.equal(failed.status, "RATE_LIMITED");
    assert.equal(failed.detail, "rate limit exceeded");
  } finally {
    cleanup();
  }
});

test("runImport：hub 拒收的条目带上具体原因（data.issues），错误码不重复", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    const rejected = { code: 400, message: "INVALID_ARGUMENT", data: { detail: "invalid argument", issues: ["files: at most 200 files"] } };
    const { fetchImpl } = hubFetch((action) => (action === "auth/verify" ? VERIFY_ONE : rejected));
    const io = lines();
    const report = await runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, yes: true, fetchImpl, out: io.out });
    const item = report.items[0]!;
    assert.equal(item.status, "INVALID_ARGUMENT");
    assert.equal(item.detail, "invalid argument; files: at most 200 files");
    assert.match(io.text(), /fail {2}s-one \(INVALID_ARGUMENT: invalid argument; files: at most 200 files\)/);
  } finally {
    cleanup();
  }
});

test("runImport：扫描期跳过的目录与没选中的候选都计入 skipped（data-model §9）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    makeSkill(dir, "s2", SKILL("s-two", "d2"));
    makeSkill(dir, "nofm", "# just markdown\n");
    makeSkill(dir, "marked", SKILL("marked-skill", "x"), { ".cinlan-knowledge.json": "{}" });
    const host = { ...HOST, import_scan: [dir] };
    const reply = (action: string) => (action === "auth/verify" ? VERIFY_ONE : IMPORT_OK);
    const tally = (r: { total: number; success: number; failed: number; skipped: number }) => [r.total, r.success, r.failed, r.skipped];

    // --yes：两条提交，两个目录在扫描时就跳过
    const all = lines();
    const r1 = await runImport({ config: CFG, host, yes: true, fetchImpl: hubFetch(reply).fetchImpl, sleep: async () => {}, out: all.out });
    assert.deepEqual(tally(r1), [4, 2, 0, 2]);
    assert.match(all.text(), /total 4 · success 2 · failed 0 · skipped 2$/);

    // 交互只选第 2 个：没选中的那个也算 skipped
    const some = lines();
    const r2 = await runImport({ config: CFG, host, interactive: true, ask: async () => "2", fetchImpl: hubFetch(reply).fetchImpl, out: some.out });
    assert.deepEqual(tally(r2), [4, 1, 0, 3]);
    assert.match(some.text(), /total 4 · success 1 · failed 0 · skipped 3$/);

    // 一个都不选、--dry-run：全部是 skipped
    const r3 = await runImport({ config: CFG, host, interactive: true, ask: async () => "s", fetchImpl: hubFetch(reply).fetchImpl, out: lines().out });
    assert.deepEqual(tally(r3), [4, 0, 0, 4]);
    const r4 = await runImport({ config: CFG, host, dryRun: true, fetchImpl: hubFetch(reply).fetchImpl, out: lines().out });
    assert.deepEqual(tally(r4), [4, 0, 0, 4]);
  } finally {
    cleanup();
  }
});

test("runImport：没有候选时，扫描期跳过的目录仍计入 skipped", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "nofm", "# just markdown\n");
    const { fetchImpl, calls } = hubFetch(() => IMPORT_OK);
    const report = await runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, yes: true, fetchImpl, out: lines().out });
    assert.deepEqual([report.total, report.success, report.failed, report.skipped], [1, 0, 0, 1]);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("runImport：非 TTY 且没 --yes 拒绝写入；TTY 交互按序号导入", async () => {
  const { dir, cleanup } = tempDir();
  try {
    makeSkill(dir, "s1", SKILL("s-one", "d1"));
    makeSkill(dir, "s2", SKILL("s-two", "d2"));
    const { fetchImpl, calls } = hubFetch(() => IMPORT_OK);
    await assert.rejects(
      () => runImport({ config: CFG, host: { ...HOST, import_scan: [dir] }, interactive: false, fetchImpl, out: lines().out }),
      /--yes 全部导入/,
    );
    assert.equal(calls.filter((c) => c.action === "asset/import").length, 0);

    const { fetchImpl: f2, calls: c2 } = hubFetch((action) => (action === "auth/verify" ? VERIFY_ONE : IMPORT_OK));
    const report = await runImport({
      config: CFG,
      host: { ...HOST, import_scan: [dir] },
      interactive: true,
      ask: async () => "2",
      fetchImpl: f2,
      out: lines().out,
    });
    assert.equal(report.success, 1);
    assert.equal(c2.find((c) => c.action === "asset/import")!.body["name"], "s-two");
  } finally {
    cleanup();
  }
});
