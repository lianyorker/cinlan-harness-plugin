import test from "node:test";
import assert from "node:assert/strict";
import { diffMode, lineDiff, SIDE_BY_SIDE_THRESHOLD } from "../src/lib/diff.js";

test("逐行 diff 标出增删与相同行", () => {
  const rows = lineDiff("a\nb\nc", "a\nx\nc");
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ["same:a", "del:b", "add:x", "same:c"],
  );
});

test("换行结尾差异不算内容变化", () => {
  assert.deepEqual(lineDiff("a\nb", "a\nb\n").map((r) => r.kind), ["same", "same"]);
});

test("超过 64 KiB 用并排模式，不做行 diff", () => {
  const big = "x".repeat(SIDE_BY_SIDE_THRESHOLD + 1);
  assert.equal(diffMode(big, "small"), "side-by-side");
  assert.equal(diffMode("small", big), "side-by-side");
  assert.equal(diffMode("small", "small"), "unified");
});
