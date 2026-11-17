import { test } from "node:test";
import assert from "node:assert/strict";

// P4（p4-workshop.md §2）：wiki / codegraph 放行——通用资产语义，layer/files 专属校验照拒。
// 复用 search.test.ts 的 fixture 形状（这里独立搭一个最小 fixture，避免跨文件依赖）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../src/db.js";
import { addMember, createTeam, createUser, type User } from "../src/meta.js";
import { applyVisibility, createAsset, planVisibility } from "../src/asset.js";
import { searchAssets } from "../src/search.js";
import type { Principal } from "../src/access.js";

function as(user: User): Principal {
  return { user: { id: user.id } };
}

test("P4: wiki and codegraph assets live through the generic asset machinery", () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-p4-"));
  const db = openDatabase({ file: join(dir, "knowledge.db") });
  try {
    const sa = createUser(db, { name: "sa", display_name: "SA", is_system_admin: true });
    const alice = createUser(db, { name: "alice", display_name: "Alice" });
    const team = createTeam(db, sa, { name: "demo", title: "Demo" });
    addMember(db, sa, team, alice);

    // wiki：纯 Markdown 长文
    const wiki = createAsset(db, as(alice), team.id, {
      type: "wiki",
      title: "值班手册 Wiki",
      content: "# 值班手册\n\n夜间 P0 告警先看 hub 日志，十分钟内留痕。",
    });
    assert.equal(wiki.asset.type, "wiki");
    // codegraph：JSON 图数据，一律当文本对待
    const cg = createAsset(db, as(alice), team.id, {
      type: "codegraph",
      title: "cinlan 代码图快照",
      content: JSON.stringify({ nodes: [{ id: "hub:serve", label: "hub serve" }], edges: [] }),
    });
    assert.equal(cg.asset.type, "codegraph");
    for (const asset of [wiki.asset, cg.asset]) {
      const plan = planVisibility(db, as(alice), asset, { visibility: "team" });
      applyVisibility(db, asset, plan.plan, alice.id);
    }

    // 检索：types=wiki / types=codegraph / 默认混检
    const wikiOnly = searchAssets(db, as(alice), { query: "值班手册", types: ["wiki"] });
    assert.deepEqual(wikiOnly.hits.map((h) => h.title), ["值班手册 Wiki"]);
    const cgOnly = searchAssets(db, as(alice), { query: "代码图", types: ["codegraph"] });
    assert.deepEqual(cgOnly.hits.map((h) => h.title), ["cinlan 代码图快照"]);
    const mixed = searchAssets(db, as(alice), { query: "十分钟内留痕" });
    assert.equal(mixed.hits.length, 1);

    // 专属校验照拒：wiki 带 layer；codegraph 带 files
    assert.throws(() => createAsset(db, as(alice), team.id, { type: "wiki", title: "x", content: "y", layer: "core" }));
    assert.throws(() =>
      createAsset(db, as(alice), team.id, {
        type: "codegraph",
        title: "x",
        content: "y",
        files: [{ path: "g.json", encoding: "utf8", content: "{}" }],
      }));
  } finally {
    closeDatabase(db);
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        // Windows 句柄释放稍晚
      }
    }
  }
});
