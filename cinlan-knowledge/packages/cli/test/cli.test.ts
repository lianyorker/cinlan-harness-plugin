import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { rpc, RpcError } from "../src/rpc.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ck-cli-"));
}

test("env wins over files", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ hub: "http://file-host:8424" }));
    writeFileSync(join(home, "key"), "ck_filekey\n");
    const cfg = resolveConfig({ CK_HOME: home, CK_HUB_URL: "http://env-host:8424/", CK_USER_KEY: "ck_envkey" });
    assert.equal(cfg.hub, "http://env-host:8424", "trailing slash stripped");
    assert.deepEqual(cfg.sources, { hub: "env", key: "env" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("files used when env is empty", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ hub: "http://file-host:8424" }));
    mkdirSync(join(home, "cache"));
    writeFileSync(join(home, "key"), "ck_filekey\n");
    const cfg = resolveConfig({ CK_HOME: home });
    assert.equal(cfg.hub, "http://file-host:8424");
    assert.equal(cfg.key, "ck_filekey");
    assert.deepEqual(cfg.sources, { hub: "file", key: "file" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("nothing configured → nulls", () => {
  const home = tempHome();
  try {
    const cfg = resolveConfig({ CK_HOME: home });
    assert.equal(cfg.hub, null);
    assert.equal(cfg.key, null);
    assert.deepEqual(cfg.sources, { hub: "none", key: "none" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("corrupt config.json is ignored", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), "{not json");
    const cfg = resolveConfig({ CK_HOME: home });
    assert.equal(cfg.hub, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rpc posts to /api/v1/<action> with bearer key and returns envelope", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fakeFetch: typeof fetch = async (input, init) => {
    seen = { url: String(input), init: init! };
    return new Response(JSON.stringify({ code: 0, message: "OK", request_id: "req_x", data: { fine: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = await rpc({ hub: "http://h:8424", key: "ck_k", action: "auth/verify", body: {}, fetchImpl: fakeFetch });
  assert.equal(env.code, 0);
  assert.equal(seen!.url, "http://h:8424/api/v1/auth/verify");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer ck_k");
  assert.equal(seen!.init.body, "{}");
});

test("rpc keeps error envelopes as-is (no throw on 4xx)", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ code: 409, message: "VERSION_CONFLICT", request_id: "req_y", data: { current_version: 4 } }),
      { status: 409 },
    );
  const env = await rpc({ hub: "http://h:8424", key: "ck_k", action: "asset/update", body: {}, fetchImpl: fakeFetch });
  assert.equal(env.code, 409);
  assert.equal(env.message, "VERSION_CONFLICT");
  assert.equal((env.data as { current_version: number }).current_version, 4);
});

test("non-envelope response → RpcError", async () => {
  const fakeFetch: typeof fetch = async () => new Response("<html>bad gateway</html>", { status: 502 });
  await assert.rejects(
    () => rpc({ hub: "http://h:8424", key: "ck_k", action: "auth/verify", body: {}, fetchImpl: fakeFetch }),
    (err: unknown) => err instanceof RpcError && /invalid response/.test((err as Error).message),
  );
});

test("network failure → RpcError", async () => {
  const fakeFetch: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => rpc({ hub: "http://h:8424", key: "ck_k", action: "auth/verify", body: {}, fetchImpl: fakeFetch }),
    (err: unknown) => err instanceof RpcError && /cannot reach hub/.test((err as Error).message),
  );
});
