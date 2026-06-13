#!/usr/bin/env node
/**
 * No-network MCP smoke test.
 *
 * Spawns the built server, completes the MCP initialize handshake, sends a
 * tools/list JSON-RPC request over stdio, and asserts:
 *   1. the response includes all 7 expected tool names;
 *   2. the `search` tool's input schema exposes exactly the expected param
 *      set (catches the silent-param-drop regression class — a param missing
 *      from the published schema is stripped before it ever reaches REST);
 *   3. search's `limit` schema pins maximum 50 (the verified REST pagelimit cap);
 *   4. serverInfo.version === server/package.json === manifest.json (the
 *      triple-version drift that went stale once before, per CHANGELOG v1.1.6).
 * Fails CI on any mismatch (catches regressions where the server boots but
 * registration or schema publication breaks silently).
 *
 * Uses a fake API key — the server only checks that one is present at
 * startup, not that it works upstream. tools/list never touches the network.
 * XDATE_DISABLE_PAID=1 is belt-and-suspenders to prevent any accidental
 * outbound call if a tool were invoked.
 *
 * Run from server/: node scripts/smoke-test-tools-list.mjs  (or: npm test)
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 8000;
const EXPECTED = [
  "company_details",
  "filter",
  "match",
  "search",
  "serff_filing",
  "serff_search",
  "talkpoints",
];
// Exact key set of SearchSchema. Exact equality also guarantees naicslist
// (intentionally unexposed — no-op upstream) stays absent.
const EXPECTED_SEARCH_PARAMS = [
  "addloptions",
  "agentlist",
  "carriergrouplist",
  "carrierlist",
  "classlist",
  "countylist",
  "fromdate",
  "fromemp",
  "industrylist",
  "limit",
  "modfrom",
  "modto",
  "offset",
  "peolist",
  "policyoptions",
  "premfrom",
  "premto",
  "siclist",
  "statelist",
  "todate",
  "toemp",
];

// Script-relative reads so this works run-from-server/ and under CI's
// working-directory: server.
const pkgVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
).version;
const manifestVersion = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url)),
).version;

const proc = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    INSURANCEXDATE_API_KEY: "ci-smoke-test-key",
    XDATE_DISABLE_PAID: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let resolved = false;

const timeout = setTimeout(() => {
  if (resolved) return;
  resolved = true;
  console.error("FAIL: timeout waiting for tools/list response");
  proc.kill();
  process.exit(1);
}, TIMEOUT_MS);

proc.stderr.on("data", (d) => process.stderr.write(d));
// A fast child death closes stdin; without this, the write EPIPEs with an
// uncaught stack instead of the clean "FAIL: server exited" message below.
proc.stdin.on("error", () => {});

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function fail(message) {
  resolved = true;
  clearTimeout(timeout);
  console.error(message);
  proc.kill();
  process.exit(1);
}

proc.stdout.on("data", (chunk) => {
  if (resolved) return;
  stdout += chunk.toString();
  // Consume completed lines; keep the trailing partial as the new buffer.
  // Re-scanning the whole buffer each chunk would re-process the id-0 line
  // and re-send the handshake (duplicate id-1 request) on every later chunk.
  const lines = stdout.split("\n");
  stdout = lines.pop() ?? "";
  for (const line of lines.filter(Boolean)) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.error) {
      fail(`FAIL: JSON-RPC error (id=${msg.id}): ${JSON.stringify(msg.error)}`);
    }
    if (msg.id === 0 && msg.result) {
      const serverVersion = msg.result.serverInfo?.version;
      if (serverVersion !== pkgVersion || serverVersion !== manifestVersion) {
        fail(
          `FAIL: version drift — serverInfo ${serverVersion}, package.json ${pkgVersion}, manifest.json ${manifestVersion}`,
        );
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      continue;
    }
    if (msg.id !== 1 || !msg.result || !Array.isArray(msg.result.tools)) continue;
    resolved = true;
    clearTimeout(timeout);
    const names = msg.result.tools.map((t) => t.name).sort();
    const expectedSorted = [...EXPECTED].sort();
    console.log("Tools registered:", names.join(", "));
    if (JSON.stringify(names) !== JSON.stringify(expectedSorted)) {
      console.error("FAIL: expected", expectedSorted, "got", names);
      proc.kill();
      process.exit(1);
    }
    const search = msg.result.tools.find((t) => t.name === "search");
    const searchParams = Object.keys(search.inputSchema?.properties ?? {}).sort();
    if (JSON.stringify(searchParams) !== JSON.stringify(EXPECTED_SEARCH_PARAMS)) {
      console.error(
        "FAIL: search input schema drift.\n  expected:",
        EXPECTED_SEARCH_PARAMS.join(", "),
        "\n  got:     ",
        searchParams.join(", "),
      );
      proc.kill();
      process.exit(1);
    }
    if (search.inputSchema.properties.limit.maximum !== 50) {
      console.error(
        "FAIL: search limit.maximum should pin the REST pagelimit cap of 50, got",
        search.inputSchema.properties.limit.maximum,
      );
      proc.kill();
      process.exit(1);
    }
    proc.kill();
    console.log(
      `PASS: all 7 tools registered, search schema (${searchParams.length} params) and version ${pkgVersion} consistent.`,
    );
    process.exit(0);
  }
});

proc.on("error", (err) => {
  if (resolved) return;
  fail(`FAIL: failed to spawn server: ${err.message}`);
});

proc.on("exit", (code, signal) => {
  if (resolved) return;
  fail(`FAIL: server exited (code=${code}, signal=${signal}) before tools/list response`);
});

send({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "insurancexdate-smoke-test", version: "0.0.0" },
  },
});
