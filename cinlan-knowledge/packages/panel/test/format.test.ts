import test from "node:test";
import assert from "node:assert/strict";
import {
  assetTypeLabel,
  assetStatusLabel,
  formatNumber,
  formatTime,
  hostLabel,
  injectionModeLabel,
  reviewStatusLabel,
  skipReasonLabel,
  visibilityLabel,
} from "../src/lib/format.js";

test("时间按本地时区格式化为 YYYY-MM-DD HH:mm，补零", () => {
  const iso = new Date(2026, 10, 13, 9, 5).toISOString();
  assert.equal(formatTime(iso), "2026-11-13 09:05");
});

test("时间缺省与非法值显示占位符，不抛错", () => {
  assert.equal(formatTime(null), "-");
  assert.equal(formatTime(""), "-");
  assert.equal(formatTime("not-a-date"), "-");
});

test("数字带千分位", () => {
  assert.equal(formatNumber(8421), "8,421");
  assert.equal(formatNumber(0), "0");
});

test("枚举标签覆盖全部取值", () => {
  assert.equal(assetTypeLabel("memory"), "记忆");
  assert.equal(assetTypeLabel("codegraph"), "代码图");
  assert.equal(assetStatusLabel("deprecated"), "已弃用");
  assert.equal(visibilityLabel("restricted"), "受限");
  assert.equal(injectionModeLabel("tool"), "工具");
  assert.equal(reviewStatusLabel("withdrawn"), "已撤回");
  assert.equal(skipReasonLabel("budget"), "预算不足");
  assert.equal(hostLabel("claude-code"), "Claude Code");
  assert.equal(hostLabel("no-such-host"), "no-such-host");
});
