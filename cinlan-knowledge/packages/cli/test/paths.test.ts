import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { expandHome } from "../src/paths.js";

/** `expandHome`：`~` 与 Windows 风格 `%VAR%`（hermes 的 `%LOCALAPPDATA%/hermes`）。 */

const HOME = "/home/ly";

test("`~` 与 `~/x` / `~\\x` 展开到 home", () => {
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("~/x", HOME), join(HOME, "x"));
  assert.equal(expandHome("~\\x", HOME), join(HOME, "x"));
});

test("`%VAR%` 从 env 展开；未定义保留字面量", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\ly\\AppData\\Local" };
  assert.equal(expandHome("%LOCALAPPDATA%/hermes", HOME, env), "C:\\Users\\ly\\AppData\\Local/hermes");
  assert.equal(expandHome("%NOPE%/x", HOME, env), "%NOPE%/x");
});

test("`%VAR%` 展开后再走 `~` 规则：env 值含 `~` 也会展开到 home；普通路径原样返回", () => {
  assert.equal(expandHome("/abs/path", HOME), "/abs/path");
  assert.equal(expandHome("relative/path", HOME), "relative/path");
  // %VAR% 先换成值，结果若以 ~ 开头照样按 home 展开（env 值允许是 ~）
  assert.equal(expandHome("%P%/x", HOME, { P: "~/sub" }), join(HOME, "sub/x"));
});

test("多个 `%VAR%` 一次展开；大小写敏感", () => {
  const env = { A: "1", B: "2" };
  assert.equal(expandHome("%A%/%B%/x", HOME, env), "1/2/x");
  assert.equal(expandHome("%a%/x", HOME, env), "%a%/x");
});
