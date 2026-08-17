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

test("account_status uses GET and permanently excludes credential, session, and Stripe fields", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const canaries = [
    "password-hash-canary",
    "session-token-canary",
    "stripe-secret-canary",
    "unreliable-access-canary",
    "unreliable-budget-canary",
  ];
  let requestUrl;
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return Response.json({
      status: "ok",
      data: {
        user: {
          apiBalance: "42.5000",
          apiFreeMonthly: "5.0000",
          mcpAccess: canaries[3],
          mcpMonthlyBudget: canaries[4],
          password: canaries[0],
          session_token: canaries[1],
          stripe: { secret: canaries[2] },
          nestedBalanceTrap: { apiBalance: "999999" },
        },
      },
    });
  };

  const result = await new XdateClient("test-key-123").accountStatus();
  assert.equal(requestUrl, "https://www.insurancexdate.com/api2/Account");
  assert.equal(requestOptions.method, "GET");
  assert.equal(requestOptions.body, undefined);
  assert.deepEqual(result.structuredContent, {
    apiBalance: "42.5000",
    apiFreeMonthly: "5.0000",
  });
  const serialized = JSON.stringify(result);
  for (const canary of canaries) assert.doesNotMatch(serialized, new RegExp(canary));
  assert.doesNotMatch(serialized, /nestedBalanceTrap/);
});

test("account_status rejects malformed account envelopes without echoing them", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const canary = "malformed-account-canary";
  globalThis.fetch = async () => Response.json({ data: { unexpected: canary } });

  const result = await new XdateClient("test-key-123").accountStatus();
  assert.equal(result.isError, true);
  assert.match(resultText(result), /invalid response/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
});
