import test from "node:test";
import assert from "node:assert/strict";
import {
  addBinding,
  BUDGET_PRESETS,
  isDirty,
  move,
  removeBinding,
  toSetRequest,
  type DraftBinding,
} from "../src/lib/loadout.js";

function draft(): DraftBinding[] {
  return [
    { asset_id: "ast_a", priority: 10, injection_mode: "inject", pin_version: null },
    { asset_id: "ast_b", priority: 20, injection_mode: "tool", pin_version: 3 },
    { asset_id: "ast_c", priority: 30, injection_mode: "inject", pin_version: null },
  ];
}

test("上移下移后优先级重新编号为 10/20/30", () => {
  const moved = move(draft(), "ast_c", "up");
  assert.deepEqual(
    moved.map((b) => `${b.asset_id}:${b.priority}`),
    ["ast_a:10", "ast_c:20", "ast_b:30"],
  );
  const back = move(moved, "ast_a", "down");
  assert.deepEqual(
    back.map((b) => `${b.asset_id}:${b.priority}`),
    ["ast_c:10", "ast_a:20", "ast_b:30"],
  );
});

test("到头不再动", () => {
  const d = draft();
  assert.deepEqual(move(d, "ast_a", "up"), d);
  assert.deepEqual(move(d, "ast_c", "down"), d);
});

test("加入与移除", () => {
  const added = addBinding(draft(), { asset_id: "ast_d", injection_mode: "inject", pin_version: null });
  assert.equal(added.at(-1)!.asset_id, "ast_d");
  assert.equal(added.at(-1)!.priority, 40);
  assert.deepEqual(
    addBinding(draft(), { asset_id: "ast_a", injection_mode: "tool", pin_version: null }).map((b) => b.asset_id),
    ["ast_a", "ast_b", "ast_c"],
    "重复加入不产生重复行",
  );
  assert.deepEqual(removeBinding(draft(), "ast_b").map((b) => b.priority), [10, 20]);
});

test("脏检查与请求体", () => {
  const saved = draft();
  assert.equal(isDirty(saved, draft()), false);
  const changed = move(draft(), "ast_b", "up");
  assert.equal(isDirty(changed, saved), true);
  assert.deepEqual(toSetRequest("agt_1", saved), {
    agent_id: "agt_1",
    bindings: [
      { asset_id: "ast_a", priority: 10, injection_mode: "inject" },
      { asset_id: "ast_b", priority: 20, injection_mode: "tool", pin_version: 3 },
      { asset_id: "ast_c", priority: 30, injection_mode: "inject" },
    ],
  });
});

test("宿主预算预设与 loadout.md 一致", () => {
  assert.deepEqual(BUDGET_PRESETS.full, { budget_chars: 12000, max_bytes: 24000 });
  assert.deepEqual(BUDGET_PRESETS.hook, { budget_chars: 8000 });
  assert.deepEqual(BUDGET_PRESETS.tool, { budget_chars: 12000 });
  assert.deepEqual(BUDGET_PRESETS.brief, { budget_chars: 1500 });
});
