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
import { request } from "node:http";
import { test } from "node:test";

const PATH_TOKEN = "test-path-token-0123456789abcdef";
const START_TIMEOUT_MS = 30_000;

function stopProcess(proc) {
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2_000);
    proc.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    proc.kill();
  });
}

/**
 * Spawns dist/http.js with the given env and resolves once it logs its
 * listening line. Returns { port, close }. Rejects (with exit code and
 * stderr) if the process exits before listening — the fail-closed tests
 * assert on exactly that.
 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/http.js"], {
      env: {
        ...process.env,
        PORT: "0",
        MCP_ALLOWED_HOSTS: "127.0.0.1",
        MCP_ALLOWED_ORIGINS: "http://127.0.0.1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopProcess(proc).then(() =>
        reject(new Error(`server did not start within ${START_TIMEOUT_MS}ms\nstdout: ${stdout}\nstderr: ${stderr}`)),
      );
    }, START_TIMEOUT_MS);

    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (settled) return;
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
            close: () => stopProcess(proc),
            stdout: () => stdout,
            stderr: () => stderr,
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

function rawPost(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });
}

function nodePost(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was not met before timeout");
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

test("BYOK: Bearer and path credentials are rejected even when identical", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  try {
    const key = "test-byok-key-123";
    assert.equal((await post(server.port, `/mcp/${key}`, initializeRequest(), {
      authorization: `Bearer ${key}`,
    })).status, 401);
    assert.equal((await post(server.port, `/mcp/${key}`, initializeRequest(), {
      authorization: "Bearer different-key-456",
    })).status, 401);
  } finally {
    await server.close();
  }
});

test("MCP endpoint requires an allowed Host and exact configured Origin", async () => {
  const server = await startServer({ MCP_BYOK: "1", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost" });
  const body = JSON.stringify(initializeRequest());
  const auth = { authorization: "Bearer test-byok-key-123" };
  try {
    const badHost = await nodePost(server.port, "/mcp", body, { ...auth, host: "evil.example" });
    assert.equal(badHost.status, 403);
    assert.doesNotMatch(badHost.body, /evil\.example/);

    const caseAndPort = await nodePost(server.port, "/mcp", body, {
      ...auth,
      host: `LOCALHOST:${server.port}`,
      origin: "http://127.0.0.1",
    });
    assert.equal(caseAndPort.status, 200);

    assert.equal((await post(server.port, "/mcp", initializeRequest(), {
      ...auth,
      origin: "https://evil.example",
    })).status, 403);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), {
      ...auth,
      origin: "http://127.0.0.1/path",
    })).status, 403);
  } finally {
    await server.close();
  }
});

test("health check is exempt from MCP Host validation", async () => {
  const server = await startServer({
    MCP_BYOK: "1",
    MCP_ALLOWED_HOSTS: "public.example",
    MCP_ALLOWED_ORIGINS: "https://public.example",
  });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), {
      authorization: "Bearer test-byok-key-123",
    })).status, 403);
  } finally {
    await server.close();
  }
});

test("MCP endpoint rejects unsupported media headers before reading a body", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  const auth = { authorization: "Bearer test-byok-key-123" };
  try {
    assert.equal((await rawPost(server.port, "/mcp", JSON.stringify(initializeRequest()), {
      ...auth,
      "content-type": "text/plain",
    })).status, 415);
    assert.equal((await rawPost(server.port, "/mcp", JSON.stringify(initializeRequest()), {
      ...auth,
      accept: "application/json",
    })).status, 406);
    assert.equal((await rawPost(server.port, "/mcp", JSON.stringify(initializeRequest()), {
      ...auth,
      accept: "application/jsonish, text/event-stream-extra",
    })).status, 406);
  } finally {
    await server.close();
  }
});

test("client JSON-RPC responses receive 202 without echoing payloads to stderr", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  try {
    const marker = "private-response-payload-0123456789";
    const response = await post(server.port, "/mcp", { jsonrpc: "2.0", id: marker, result: { query: marker } }, {
      authorization: "Bearer test-byok-key-123",
    });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.doesNotMatch(server.stderr(), new RegExp(marker));
  } finally {
    await server.close();
  }
});

test("malformed JSON is logged with a stable code and never a body excerpt", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  const canary = "secret-log-canary-123";
  try {
    const response = await rawPost(server.port, "/mcp", `{"password":"${canary}",`, {
      authorization: "Bearer test-byok-key-123",
    });
    assert.equal(response.status, 400);
    await waitFor(() => server.stdout().includes('"error":"invalid_body"'));
    assert.doesNotMatch(server.stdout(), new RegExp(canary));
    assert.doesNotMatch(server.stderr(), new RegExp(canary));
  } finally {
    await server.close();
  }
});

test("caller-controlled method and tool names are not copied into access logs", async () => {
  const server = await startServer({ MCP_BYOK: "1" });
  const canary = "untrusted-log-field-123";
  try {
    await post(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: `${canary}${"x".repeat(20_000)}`, arguments: {} },
    }, { authorization: "Bearer test-byok-key-123" });
    await waitFor(() => server.stdout().includes('"attemptedMethods"'));
    assert.doesNotMatch(server.stdout(), new RegExp(canary));
    assert.doesNotMatch(server.stderr(), new RegExp(canary));
  } finally {
    await server.close();
  }
});

test("oversize declared request bodies receive 413 and release admission state", async () => {
  const server = await startServer({ MCP_BYOK: "1", MCP_MAX_INFLIGHT_REQUESTS: "1" });
  const auth = { authorization: "Bearer test-byok-key-123" };
  try {
    assert.equal((await rawPost(server.port, "/mcp", `"${"x".repeat(1_048_576)}"`, auth)).status, 413);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), auth)).status, 200);
  } finally {
    await server.close();
  }
});

test("slow request bodies time out with 408", async () => {
  const server = await startServer({ MCP_BYOK: "1", MCP_BODY_TIMEOUT_MS: "100" });
  try {
    const response = new Promise((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port: server.port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: "Bearer test-byok-key-123",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": "100",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.write("{");
    });
    assert.equal(await response, 408);
  } finally {
    await server.close();
  }
});

test("inflight limit releases when a slow client disconnects", async () => {
  const server = await startServer({
    MCP_BYOK: "1",
    MCP_MAX_INFLIGHT_REQUESTS: "1",
    MCP_BODY_TIMEOUT_MS: "5000",
  });
  const headers = { authorization: "Bearer test-byok-key-123" };
  let slow;
  try {
    slow = request({
      hostname: "127.0.0.1",
      port: server.port,
      path: "/mcp",
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": "100",
      },
    });
    slow.on("error", () => {});
    slow.write("{");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await post(server.port, "/mcp", initializeRequest(), headers)).status, 503);
    slow.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await post(server.port, "/mcp", initializeRequest(), headers)).status, 200);
  } finally {
    slow?.destroy();
    await server.close();
  }
});

// --- Rate limiting ----------------------------------------------------------

test("authenticated malformed bodies consume the pre-parse ingress budget", async () => {
  const server = await startServer({ MCP_BYOK: "1", MCP_INGRESS_RATE_LIMIT_PER_MIN: "2" });
  const headers = { authorization: "Bearer test-byok-key-123" };
  try {
    assert.equal((await rawPost(server.port, "/mcp", "{", headers)).status, 400);
    assert.equal((await rawPost(server.port, "/mcp", "{", headers)).status, 400);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), headers)).status, 429);
  } finally {
    await server.close();
  }
});

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

test("BYOK: a key-throttled caller does not drain the global budget", async () => {
  const server = await startServer({
    MCP_BYOK: "1",
    MCP_RATE_LIMIT_PER_MIN: "1",
    MCP_GLOBAL_RATE_LIMIT_PER_MIN: "2",
  });
  try {
    const keyA = { authorization: "Bearer throttled-key-aaaa" };
    const keyB = { authorization: "Bearer innocent-key-bbbb" };
    assert.equal((await post(server.port, "/mcp", initializeRequest(), keyA)).status, 200);
    // keyA is now over ITS limit; these denials must not charge the host bucket.
    assert.equal((await post(server.port, "/mcp", initializeRequest(), keyA)).status, 429);
    assert.equal((await post(server.port, "/mcp", initializeRequest(), keyA)).status, 429);
    // Global has 1 of 2 tokens left — keyB must still get through.
    assert.equal(
      (await post(server.port, "/mcp", initializeRequest(), keyB)).status,
      200,
      "key-level denials must not consume the global budget",
    );
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
