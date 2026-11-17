import test from "node:test";
import assert from "node:assert/strict";
import { buildPath, parseRoute } from "../src/lib/router.js";

test("根路径进 /assets", () => {
  assert.deepEqual(parseRoute("/panel/"), { name: "assets", query: new URLSearchParams() });
  assert.deepEqual(parseRoute("/panel"), { name: "assets", query: new URLSearchParams() });
  assert.deepEqual(parseRoute("/panel/assets"), { name: "assets", query: new URLSearchParams() });
});

test("顶层页面路由", () => {
  for (const name of ["reviews", "agents", "teams", "access", "usage", "audit", "guide"] as const) {
    const r = parseRoute(`/panel/${name}`);
    assert.equal(r.name, name);
  }
});

test("详情路由带 id", () => {
  assert.deepEqual(parseRoute("/panel/agents/agt_1"), {
    name: "agent",
    id: "agt_1",
    query: new URLSearchParams(),
  });
  assert.deepEqual(parseRoute("/panel/teams/team_1?tab=members"), {
    name: "team",
    id: "team_1",
    query: new URLSearchParams("tab=members"),
  });
});

test("查询串原样带出，供抽屉使用", () => {
  const r = parseRoute("/panel/assets?id=ast_1&tab=history");
  assert.equal(r.name, "assets");
  assert.equal(r.query.get("id"), "ast_1");
  assert.equal(r.query.get("tab"), "history");
});

test("尾斜杠与重复斜杠归一", () => {
  assert.equal(parseRoute("/panel/assets/").name, "assets");
  assert.equal(parseRoute("/panel//agents//agt_1").name, "agent");
});

test("未知路径进 notFound", () => {
  assert.equal(parseRoute("/panel/nope").name, "notFound");
  assert.equal(parseRoute("/panel/agents/agt_1/extra").name, "notFound");
  assert.equal(parseRoute("/panel/login").name, "login");
});

test("buildPath 与解析互逆", () => {
  assert.equal(buildPath({ name: "assets" }), "/panel/assets");
  assert.equal(buildPath({ name: "agent", id: "agt_1" }), "/panel/agents/agt_1");
  assert.equal(buildPath({ name: "team", id: "team_1" }), "/panel/teams/team_1");
  assert.equal(buildPath({ name: "assets", query: { id: "ast_1" } }), "/panel/assets?id=ast_1");
});
