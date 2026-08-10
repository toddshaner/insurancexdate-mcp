/**
 * Integration tests for the remote HTTP entrypoint (dist/http.js): each test
 * spawns the real server on an ephemeral port (PORT=0) and talks to it over
 * HTTP. No network beyond localhost — no request here ever carries a real
 * key or reaches the upstream API (initialize/tools-list only).
 *
 * Covers the PR-review findings:
 *   - malformed percent-encoding (/mcp/%) must not kill the process
 *   - JSON-RPC batches are charged per request, not per POST
 *   - the limiter applies in private mode too
 *   - the BYOK host-wide backstop caps fabricated fresh keys
 *   - an invalid rate-limit env value refuses to start (fail closed)
 *
 * Run from server/: npm test (builds first), or node --test test/
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const PATH_TOKEN = "test-path-token-0123456789abcdef";
const START_TIMEOUT_MS = 8000;

/**
 * Spawns dist/http.js with the given env and resolves once it logs its
 * listening line. Returns { port, close }. Rejects (with exit code and
 * stderr) if the process exits before listening — the fail-closed tests
 * assert on exactly that.
 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/http.js"], {
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`server did not start within ${START_TIMEOUT_MS}ms\nstderr: ${stderr}`));
    }, START_TIMEOUT_MS);

    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      for (const line of stdout.split("\n").filter(Boolean)) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.evt === "listening") {
          settled = true;
          clearTimeout(timeout);
          resolve({
            port: msg.port,
            close: () => {
              proc.kill();
              return new Promise((r) => proc.once("exit", r));
            },
          });
          return;
        }
      }
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(Object.assign(new Error(`server exited before listening (code=${code})\nstderr: ${stderr}`), { code, stderr }));
    });
  });
}

function initializeRequest(id = 0) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.0.0" },
    },
  };
}

function post(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// --- Crash resistance -------------------------------------------------------

test("BYOK: POST /mcp/% (malformed percent-encoding) is a 4xx, not a process kill", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  try {
    const res = await post(server.port, "/mcp/%", initializeRequest());
    assert.equal(res.status, 401, "malformed key shape should read as missing credential");
    const alive = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(alive.status, 200, "server must still be serving after the malformed request");
  } finally {
    await server.close();
  }
});

test("private: POST /mcp/% is a 404, not a process kill", async () => {
  const server = await startServer({ INSURANCEXDATE_API_KEY: "test-key-123", MCP_PATH_TOKEN: PATH_TOKEN });
  try {
    const res = await post(server.port, "/mcp/%", initializeRequest());
    assert.equal(res.status, 404);
    const alive = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(alive.status, 200);
  } finally {
    await server.close();
  }
});

// --- Auth basics ------------------------------------------------------------

test("BYOK: request without a credential gets 401; with one, initialize succeeds", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  try {
    assert.equal((await post(server.port, "/mcp", initializeRequest())).status, 401);
    const ok = await post(server.port, "/mcp", initializeRequest(), {
      authorization: "Bearer test-byok-key-123",
    });
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
  }
});

test("private: wrong token 404s, correct token initializes", async () => {
  const server = await startServer({ INSURANCEXDATE_API_KEY: "test-key-123", MCP_PATH_TOKEN: PATH_TOKEN });
  try {
    assert.equal((await post(server.port, "/mcp/not-the-token-0000000000", initializeRequest())).status, 404);
    assert.equal((await post(server.port, `/mcp/${PATH_TOKEN}`, initializeRequest())).status, 200);
  } finally {
    await server.close();
  }
});

// --- Rate limiting ----------------------------------------------------------

test("BYOK: per-key limit denies with 429 once spent", async () => {
  const server = await startServer({ MCP_BYOK: "1", MCP_RATE_LIMIT_PER_MIN: "2" });
  try {
    const headers = { authorization: "Bearer test-byok-key-123" };
    assert.equal((await post(server.port, "/mcp", initializeRequest(), headers)).status, 200);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), headers)).status, 200);
    const limited = await post(server.port, "/mcp", initializeRequest(), headers);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally {
    await server.close();
  }
});

test("BYOK: a JSON-RPC batch is charged per request it carries, not as one", async () => {
  const server = await startServer({ MCP_BYOK: "1", MCP_RATE_LIMIT_PER_MIN: "2" });
  try {
    const headers = { authorization: "Bearer test-byok-key-123" };
    // Batch of 3 against a budget of 2: denied outright — under the old
    // one-token-per-POST accounting this would have cost 1 and sailed through.
    const batch = [initializeRequest(0), initializeRequest(1), initializeRequest(2)];
    assert.equal((await post(server.port, "/mcp", batch, headers)).status, 429);
    // The denied batch consumed nothing, and a batch within budget passes
    // the limiter: a batch of 2 spends the full budget of 2...
    const batchOfTwo = [initializeRequest(0), initializeRequest(1)];
    const spent = await post(server.port, "/mcp", batchOfTwo, headers);
    assert.notEqual(spent.status, 429, "batch within budget must pass the limiter");
    // ...so the next single request is denied — the batch cost 2, not 1.
    assert.equal((await post(server.port, "/mcp", initializeRequest(), headers)).status, 429);
  } finally {
    await server.close();
  }
});

test("BYOK: host-wide backstop caps fabricated fresh keys", async () => {
  const server = await startServer({
    MCP_BYOK: "1",
    MCP_RATE_LIMIT_PER_MIN: "100",
    MCP_GLOBAL_RATE_LIMIT_PER_MIN: "2",
  });
  try {
    // Each request presents a different valid-shaped key, so each gets a
    // fresh per-key bucket — only the global bucket can stop the flood.
    assert.equal((await post(server.port, "/mcp", initializeRequest(), { authorization: "Bearer fresh-key-aaaaaaaa" })).status, 200);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), { authorization: "Bearer fresh-key-bbbbbbbb" })).status, 200);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), { authorization: "Bearer fresh-key-cccccccc" })).status, 429);
  } finally {
    await server.close();
  }
});

test("private mode is rate-limited too", async () => {
  const server = await startServer({
    INSURANCEXDATE_API_KEY: "test-key-123",
    MCP_PATH_TOKEN: PATH_TOKEN,
    MCP_RATE_LIMIT_PER_MIN: "1",
  });
  try {
    assert.equal((await post(server.port, `/mcp/${PATH_TOKEN}`, initializeRequest())).status, 200);
    assert.equal((await post(server.port, `/mcp/${PATH_TOKEN}`, initializeRequest())).status, 429);
  } finally {
    await server.close();
  }
});

// --- Fail-closed configuration ---------------------------------------------

test("an invalid MCP_RATE_LIMIT_PER_MIN refuses to start instead of failing open", async () => {
  await assert.rejects(
    startServer({ MCP_BYOK: "1", MCP_RATE_LIMIT_PER_MIN: "abc" }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /MCP_RATE_LIMIT_PER_MIN/);
      return true;
    },
  );
});

test("an invalid MCP_GLOBAL_RATE_LIMIT_PER_MIN refuses to start too", async () => {
  await assert.rejects(
    startServer({ MCP_BYOK: "1", MCP_GLOBAL_RATE_LIMIT_PER_MIN: "-5" }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /MCP_GLOBAL_RATE_LIMIT_PER_MIN/);
      return true;
    },
  );
});
