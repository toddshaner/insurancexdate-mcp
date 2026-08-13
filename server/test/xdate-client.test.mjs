import assert from "node:assert/strict";
import { test } from "node:test";

import { XdateClient } from "../dist/xdate-client.js";

function resultText(result) {
  return result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

test("upstream HTTP bodies and causes are not exposed to MCP callers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const canary = "upstream-secret-canary-123";
  globalThis.fetch = async () => new Response(canary, { status: 500, statusText: canary });

  const result = await new XdateClient("test-key-123").search({});
  assert.equal(result.isError, true);
  assert.doesNotMatch(resultText(result), new RegExp(canary));
  assert.match(resultText(result), /upstream service rejected the request/);
});

test("upstream responses are cancelled once the byte ceiling is crossed", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 });

  const result = await new XdateClient("test-key-123").search({});
  assert.equal(result.isError, true);
  assert.match(resultText(result), /exceeded the safety limit/);
  assert.equal(cancelled, true);
});

test("request cancellation reaches fetch and redirects are disabled", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestAbort = new AbortController();
  let fetchOptions;
  globalThis.fetch = async (_url, options) => {
    fetchOptions = options;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };

  const pending = new XdateClient("test-key-123", requestAbort.signal).search({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchOptions.redirect, "error");
  requestAbort.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /cancelled or timed out/);
});
