import { test } from "node:test";
import assert from "node:assert/strict";
import { httpSkillSource } from "../src/source.js";
import { hubFetch } from "./support.js";

/**
 * `asset/get` 取值层：版本必须钉住、base64/utf8 解码、路径回执校验。
 */

const OPTS = { hub: "http://hub:8424", key: "ck_k" };

function getData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: { content: "SKILL 正文" }, files: [{ path: "refs/a.md", bytes: 3 }], ...overrides };
}

test("read pins version and maps file list", async () => {
  const hub = hubFetch(() => ({ data: getData() }));
  const source = httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl });
  const out = await source.read("ast_1", 7);
  assert.equal(out.content, "SKILL 正文");
  assert.deepEqual(out.files, [{ path: "refs/a.md", bytes: 3 }]);
  assert.equal(hub.calls[0]!.action, "asset/get");
  assert.deepEqual(hub.calls[0]!.body, { asset_id: "ast_1", version: 7 });
});

test("read without files array still works", async () => {
  const hub = hubFetch(() => ({ data: { version: { content: "x" } } }));
  const out = await httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).read("ast_1", 1);
  assert.deepEqual(out.files, []);
});

test("read with no version content → explicit error", async () => {
  const hub = hubFetch(() => ({ data: { version: {} } }));
  await assert.rejects(() => httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).read("ast_1", 3), /version 3 of ast_1 has no content/);
});

test("read with a malformed file entry → explicit error", async () => {
  const hub = hubFetch(() => ({ data: getData({ files: [{ path: "a.md" }] }) }));
  await assert.rejects(() => httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).read("ast_1", 1), /bad file entry/);
});

test("readFile decodes base64 and echoes the pinned version + path", async () => {
  const hub = hubFetch(() => ({ data: { file: { path: "refs/a.md", encoding: "base64", content: Buffer.from("清单", "utf8").toString("base64") } } }));
  const bytes = await httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).readFile("ast_1", 5, "refs/a.md");
  assert.equal(bytes.toString("utf8"), "清单");
  assert.deepEqual(hub.calls[0]!.body, { asset_id: "ast_1", version: 5, path: "refs/a.md" });
});

test("readFile accepts utf8 encoding", async () => {
  const hub = hubFetch(() => ({ data: { file: { path: "a.md", encoding: "utf8", content: "纯文本" } } }));
  const bytes = await httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).readFile("ast_1", 1, "a.md");
  assert.equal(bytes.toString("utf8"), "纯文本");
});

test("readFile rejects unknown encoding instead of guessing", async () => {
  const hub = hubFetch(() => ({ data: { file: { path: "a.md", encoding: "hex", content: "00" } } }));
  await assert.rejects(() => httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).readFile("ast_1", 1, "a.md"), /unsupported encoding hex/);
});

test("readFile rejects a path mismatch", async () => {
  const hub = hubFetch(() => ({ data: { file: { path: "other.md", encoding: "base64", content: "" } } }));
  await assert.rejects(() => httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).readFile("ast_1", 1, "a.md"), /asked for a\.md, hub returned other\.md/);
});

test("readFile with no file in the reply → explicit error", async () => {
  const hub = hubFetch(() => ({ data: {} }));
  await assert.rejects(() => httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).readFile("ast_1", 1, "a.md"), /returned no file/);
});

test("hub error envelope surfaces as the envelope error", async () => {
  const hub = hubFetch(() => ({ code: 404, message: "NOT_FOUND" }));
  await assert.rejects(() => httpSkillSource({ ...OPTS, fetchImpl: hub.fetchImpl }).read("ast_1", 1), /NOT_FOUND/);
});
