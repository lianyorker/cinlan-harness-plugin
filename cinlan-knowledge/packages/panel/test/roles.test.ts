import test from "node:test";
import assert from "node:assert/strict";
import { canSeeAudit, canSeeUsage, findMembership, menuFor, roleLabel } from "../src/lib/roles.js";
import type { Verification } from "@cinlan/knowledge-sdk";

const member: Verification = {
  user: {
    id: "usr_1",
    name: "lin",
    display_name: "Lin",
    is_system_admin: false,
    status: "active",
    created_at: "2026-11-12T00:00:00.000Z",
  },
  is_system_admin: false,
  teams: [
    { team_id: "t1", team: "core", role: "member" },
    { team_id: "t2", team: "ops", role: "admin" },
  ],
  server_version: "0.1.0",
};

const admin: Verification = { ...member, is_system_admin: true, teams: [] };

test("菜单：普通成员看不到用量与审计", () => {
  const plain: Verification = { ...member, teams: [{ team_id: "t1", team: "core", role: "member" }] };
  const names = menuFor(plain).map((i) => i.path);
  assert.ok(names.includes("/assets"));
  assert.ok(!names.includes("/usage"));
  assert.ok(!names.includes("/audit"));
});

test("菜单：任一团队管理员能看到用量与审计，SA 永远能看到", () => {
  assert.ok(menuFor(member).map((i) => i.path).includes("/usage"));
  assert.ok(canSeeUsage(member, "ops"));
  assert.ok(!canSeeUsage(member, "core"));
  assert.ok(!canSeeAudit(member, "core"));
  assert.ok(canSeeUsage(admin, "whatever"));
  assert.ok(canSeeAudit(admin, null));
});

test("团队角色查询只认成员表", () => {
  assert.equal(roleLabel(findMembership(member, "ops")?.role), "团队管理员");
  assert.equal(roleLabel(findMembership(member, "core")?.role), "成员");
  assert.equal(findMembership(member, "nope"), null);
  assert.equal(findMembership(admin, "nope"), null);
});
