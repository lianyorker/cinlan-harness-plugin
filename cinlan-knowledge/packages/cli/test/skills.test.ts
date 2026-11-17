import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolveSkill } from "@cinlan/knowledge-sdk";
import { MARKER_FILE, materializeSkills, type SkillSource } from "../src/skills.js";

/**
 * skill 物化（loadout.md §7）：平铺、标记、引用计数、冲突不动、版本优先、路径校验。
 */

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ck-skills-"));
}

function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = tempRoot();
  const done = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const maybe = fn(root);
    return maybe instanceof Promise ? maybe.finally(done) : done();
  } catch (err) {
    done();
    throw err;
  }
}

function skill(name: string, overrides: Partial<ResolveSkill> = {}): ResolveSkill {
  return { asset_id: `ast_${name}`, name, version: 1, content_hash: "h1", ...overrides };
}

/** 内存来源：`files` 是附属文件内容，path → 内容。 */
function memorySource(contents: Record<string, { content: string; files?: Record<string, string> }>): SkillSource {
  return {
    async read(assetId, version) {
      const entry = contents[`${assetId}@${version}`] ?? contents[assetId];
      assert.ok(entry !== undefined, `unexpected read ${assetId}@${version}`);
      return { content: entry.content, files: Object.keys(entry.files ?? {}).map((path) => ({ path, bytes: Buffer.byteLength(entry.files![path]!) })) };
    },
    async readFile(assetId, version, path) {
      const entry = contents[`${assetId}@${version}`] ?? contents[assetId];
      assert.ok(entry?.files?.[path] !== undefined, `unexpected file ${assetId}@${version}/${path}`);
      return Buffer.from(entry.files[path]!, "utf8");
    },
  };
}

function markerOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8")) as Record<string, unknown>;
}

test("first materialization writes SKILL.md, files, and marker", () =>
  withRoot(async (root) => {
    const source = memorySource({ ast_audit: { content: "---\nname: audit\n---\n正文", files: { "refs/check.md": "清单" } } });
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit")], source, now: () => "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(out.written, ["audit"]);
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), "---\nname: audit\n---\n正文");
    assert.equal(readFileSync(join(root, "audit", "refs", "check.md"), "utf8"), "清单");
    const marker = markerOf(join(root, "audit"));
    assert.equal(marker["asset_id"], "ast_audit");
    assert.deepEqual(marker["agents"], ["ag_1"]);
    assert.equal(marker["materialized_at"], "2026-01-01T00:00:00.000Z");
  }));

test("same content again → unchanged, no rewrite, agent added to refcount", () =>
  withRoot(async (root) => {
    const source = memorySource({ ast_audit: { content: "body" } });
    await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit")], source });
    const before = readFileSync(join(root, "audit", "SKILL.md"), "utf8");
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_2", skills: [skill("audit")], source });
    assert.deepEqual(out.skipped, [{ name: "audit", reason: "unchanged" }]);
    assert.deepEqual(markerOf(join(root, "audit"))["agents"], ["ag_1", "ag_2"]);
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), before);
  }));

test("changed content → rewritten, refcount reset to the new version's agents", () =>
  withRoot(async (root) => {
    await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit")], source: memorySource({ ast_audit: { content: "v1" } }) });
    const out = await materializeSkills({
      skillRoot: root,
      agentId: "ag_2",
      skills: [skill("audit", { version: 2 })],
      source: memorySource({ "ast_audit@2": { content: "v2" } }),
    });
    assert.deepEqual(out.written, ["audit"]);
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), "v2");
    const marker = markerOf(join(root, "audit"));
    assert.equal(marker["version"], 2);
    assert.deepEqual(marker["agents"], ["ag_2"]);
  }));

test("unmarked same-name directory is left alone and reported as conflict", () =>
  withRoot(async (root) => {
    mkdirSync(join(root, "audit"));
    writeFileSync(join(root, "audit", "SKILL.md"), "手写的");
    let read = false;
    const source: SkillSource = {
      read: async () => {
        read = true;
        return { content: "x", files: [] };
      },
      readFile: async () => Buffer.from(""),
    };
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit")], source });
    assert.deepEqual(out.skipped, [{ name: "audit", reason: "conflict" }]);
    assert.equal(read, false, "must not even fetch when the directory is foreign");
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), "手写的");
    assert.equal(existsSync(join(root, "audit", MARKER_FILE)), false);
  }));

test("same name, different asset_id → conflict, foreign marker untouched", () =>
  withRoot(async (root) => {
    await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit", { asset_id: "ast_other" })], source: memorySource({ ast_other: { content: "别人" } }) });
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_2", skills: [skill("audit")], source: memorySource({ ast_audit: { content: "我的" } }) });
    assert.deepEqual(out.skipped, [{ name: "audit", reason: "conflict" }]);
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), "别人");
  }));

test("existing higher version is kept", () =>
  withRoot(async (root) => {
    await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit", { version: 3 })], source: memorySource({ "ast_audit@3": { content: "v3" } }) });
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit", { version: 2 })], source: memorySource({ "ast_audit@2": { content: "v2" } }) });
    assert.deepEqual(out.skipped, [{ name: "audit", reason: "unchanged" }]);
    assert.equal(readFileSync(join(root, "audit", "SKILL.md"), "utf8"), "v3");
  }));

test("agent dropping out of the loadout decrements; last one removes the directory", () =>
  withRoot(async (root) => {
    const source = memorySource({ ast_audit: { content: "x" } });
    await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit")], source });
    const out1 = await materializeSkills({ skillRoot: root, agentId: "ag_2", skills: [skill("audit")], source });
    assert.deepEqual(out1.skipped, [{ name: "audit", reason: "unchanged" }]);
    // ag_1 不再绑定：只退出自己
    const out2 = await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [], source });
    assert.deepEqual(out2.removed, []);
    assert.deepEqual(markerOf(join(root, "audit"))["agents"], ["ag_2"]);
    const out3 = await materializeSkills({ skillRoot: root, agentId: "ag_2", skills: [], source });
    assert.deepEqual(out3.removed, ["audit"]);
    assert.equal(existsSync(join(root, "audit")), false);
  }));

test("unmarked sibling directories are never removed", () =>
  withRoot(async (root) => {
    mkdirSync(join(root, "handmade"));
    writeFileSync(join(root, "handmade", "SKILL.md"), "keep me");
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [], source: memorySource({}) });
    assert.deepEqual(out.removed, []);
    assert.equal(readFileSync(join(root, "handmade", "SKILL.md"), "utf8"), "keep me");
  }));

test("traversal in a file path is rejected before anything lands", () =>
  withRoot(async (root) => {
    const source = memorySource({ ast_audit: { content: "x", files: { "../escape.md": "bad" } } });
    await assert.rejects(
      () => materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("audit")], source }),
      /unsafe path/,
    );
    assert.equal(existsSync(join(root, "audit")), false);
    assert.equal(existsSync(join(root, "..", "escape.md")), false);
  }));

test("duplicate and unrelated assets in one run: written once each, name conflicts deduped upstream", () =>
  withRoot(async (root) => {
    const source = memorySource({ ast_a: { content: "A" }, ast_b: { content: "B" } });
    const out = await materializeSkills({ skillRoot: root, agentId: "ag_1", skills: [skill("a"), skill("b")], source });
    assert.deepEqual(out.written.sort(), ["a", "b"]);
    assert.equal(readFileSync(join(root, "a", "SKILL.md"), "utf8"), "A");
    assert.equal(readFileSync(join(root, "b", "SKILL.md"), "utf8"), "B");
  }));
