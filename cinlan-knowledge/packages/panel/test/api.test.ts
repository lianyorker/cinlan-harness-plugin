import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createClient, type FetchLike } from "../src/lib/api.js";

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function reply(init: Reply): {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
} {
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    json: async () => init.body,
  };
}

function client(fetchImpl: FetchLike, key: string | null = "ck_test") {
  return createClient({ baseUrl: "", getKey: () => key, fetch: fetchImpl });
}

test("成功调用返回信封里的 data，并带上 Bearer 头", async () => {
  let seen: { url: string; init: any } | null = null;
  const c = client(async (url, init) => {
    seen = { url, init };
    return reply({
      status: 200,
      body: {
        code: 0,
        message: "OK",
        request_id: "req_1",
        data: { is_system_admin: true, teams: [], user: { name: "yorker" } },
      },
    });
  });
  const data = await c.call("auth/verify", {});
  assert.equal(data.is_system_admin, true);
  assert.equal(seen!.url, "/api/v1/auth/verify");
  assert.equal(seen!.init.method, "POST");
  assert.equal(seen!.init.headers.authorization, "Bearer ck_test");
  assert.equal(seen!.init.headers["content-type"], "application/json");
  assert.equal(seen!.init.body, "{}");
});

test("错误信封转成 ApiError，带 code / status / request_id / detail", async () => {
  const c = client(async () =>
    reply({
      status: 409,
      body: {
        code: 409,
        message: "VERSION_CONFLICT",
        request_id: "req_666",
        data: { detail: "base_version is not current", current_version: 4 },
      },
    }),
  );
  await assert.rejects(c.call("asset/update", { asset_id: "ast_1", base_version: 2 }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "VERSION_CONFLICT");
    assert.equal(err.status, 409);
    assert.equal(err.requestId, "req_666");
    assert.equal(err.detail, "base_version is not current");
    assert.equal(err.data.current_version, 4);
    return true;
  });
});

test("429 的等待秒数优先读 Retry-After 头，其次读 data.retry_after", async () => {
  const withHeader = client(async () =>
    reply({
      status: 429,
      body: { code: 429, message: "RATE_LIMITED", request_id: "req_7", data: { detail: "slow down", retry_after: 30 } },
      headers: { "Retry-After": "60" },
    }),
  );
  await assert.rejects(withHeader.call("auth/verify", {}), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "RATE_LIMITED");
    assert.equal(err.retryAfter, 60);
    return true;
  });

  const fromBody = client(async () =>
    reply({
      status: 429,
      body: { code: 429, message: "RATE_LIMITED", request_id: "req_7", data: { detail: "slow down", retry_after: 30 } },
    }),
  );
  await assert.rejects(fromBody.call("auth/verify", {}), (err: unknown) => {
    assert.equal((err as ApiError).retryAfter, 30);
    return true;
  });
});

test("网络失败转成 NETWORK，不重试", async () => {
  let calls = 0;
  const c = client(async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(c.call("auth/verify", {}), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "NETWORK");
    assert.equal(err.retryAfter, null);
    assert.equal(err.requestId, "");
    return true;
  });
  assert.equal(calls, 1);
});

test("响应不是合法信封转成 BAD_RESPONSE", async () => {
  const c = client(async () => reply({ status: 200, body: { hello: 1 } }));
  await assert.rejects(c.call("auth/verify", {}), (err: unknown) => {
    assert.equal((err as ApiError).code, "BAD_RESPONSE");
    return true;
  });
});

test("401 先清理会话再抛出", async () => {
  let unauthorized = 0;
  const c = createClient({
    baseUrl: "",
    getKey: () => "ck_dead",
    onUnauthorized: () => {
      unauthorized += 1;
    },
    fetch: async () =>
      reply({
        status: 401,
        body: { code: 401, message: "UNAUTHORIZED", request_id: "req_8", data: { detail: "bad key" } },
      }),
  });
  await assert.rejects(c.call("auth/verify", {}), (err: unknown) => {
    assert.equal((err as ApiError).code, "UNAUTHORIZED");
    return true;
  });
  assert.equal(unauthorized, 1);
});

test("未知错误码按 BAD_RESPONSE 处理", async () => {
  const c = client(async () =>
    reply({ status: 500, body: { code: 500, message: "SOMETHING_NEW", request_id: "req_9", data: {} } }),
  );
  await assert.rejects(c.call("auth/verify", {}), (err: unknown) => {
    assert.equal((err as ApiError).code, "BAD_RESPONSE");
    assert.equal((err as ApiError).status, 500);
    return true;
  });
});
