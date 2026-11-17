import test from "node:test";
import assert from "node:assert/strict";
import { createSession, MEMORY_STORE_KEYS, type KeyValueStore } from "../src/lib/session.js";

function memoryStore(): KeyValueStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => {
      raw.set(k, v);
    },
    removeItem: (k) => {
      raw.delete(k);
    },
  };
}

test("只持久化 key 与当前团队，验证明细每次重取", () => {
  const store = memoryStore();
  const s = createSession(store);
  s.saveKey("ck_live");
  s.setCurrentTeam("cinlan");
  s.setVerification({
    user: {
      id: "usr_1",
      name: "yorker",
      display_name: "Yorker",
      is_system_admin: true,
      status: "active",
      created_at: "2026-11-12T00:00:00.000Z",
    },
    is_system_admin: true,
    teams: [{ team_id: "team_1", team: "cinlan", role: "admin" }],
    server_version: "0.1.0",
  });

  const raw = [...store.raw.values()].join("\n");
  assert.ok(!raw.includes("server_version"), "验证明细不能落进 sessionStorage");
  assert.ok(!raw.includes("Yorker"));

  const reloaded = createSession(store);
  assert.equal(reloaded.key, "ck_live");
  assert.equal(reloaded.currentTeam, "cinlan");
  assert.equal(reloaded.verification, null);
});

test("clear 清掉全部键", () => {
  const store = memoryStore();
  const s = createSession(store);
  s.saveKey("ck_live");
  s.setCurrentTeam("cinlan");
  s.clear();
  assert.equal(store.raw.size, 0);
  assert.equal(createSession(store).key, null);
  for (const k of MEMORY_STORE_KEYS) assert.equal(store.getItem(k), null);
});

test("当前团队不在名下时回落到第一个团队", () => {
  const store = memoryStore();
  const s = createSession(store);
  s.setCurrentTeam("gone");
  s.setVerification({
    user: {
      id: "usr_1",
      name: "u",
      display_name: "U",
      is_system_admin: false,
      status: "active",
      created_at: "2026-11-12T00:00:00.000Z",
    },
    is_system_admin: false,
    teams: [
      { team_id: "t1", team: "a", role: "member" },
      { team_id: "t2", team: "b", role: "admin" },
    ],
    server_version: "0.1.0",
  });
  assert.equal(s.currentTeam, "a");
});
