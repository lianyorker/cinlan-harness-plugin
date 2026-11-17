import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES } from "@cinlan/knowledge-sdk";
import { describeErrorCode } from "../src/lib/errors.js";

test("每个错误码都有中文说明", () => {
  for (const code of ERROR_CODES) {
    const text = describeErrorCode(code);
    assert.equal(typeof text, "string", code);
    assert.ok(text.length > 0, `${code} 缺说明`);
    assert.notEqual(text, code, `${code} 的说明不能就是码本身`);
  }
});

test("客户端自造的两个错误码也有说明", () => {
  assert.match(describeErrorCode("NETWORK"), /hub/);
  assert.match(describeErrorCode("BAD_RESPONSE"), /响应|格式/);
});
