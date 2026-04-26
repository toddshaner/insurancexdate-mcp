#!/usr/bin/env node
/**
 * No-network MCP tools/list smoke test.
 *
 * Spawns the built server, sends a tools/list JSON-RPC request over stdio,
 * and asserts the response includes all 7 expected tool names. Fails CI
 * if any tool fails to register (catches regressions where the server
 * boots but tool registration breaks silently).
 *
 * Uses a fake API key — the server only checks that one is present at
 * startup, not that it works upstream. tools/list never touches the network.
 * XDATE_DISABLE_PAID=1 is belt-and-suspenders to prevent any accidental
 * outbound call if a tool were invoked.
 *
 * Run from server/: node scripts/smoke-test-tools-list.mjs
 */

import { spawn } from "node:child_process";

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

proc.stdout.on("data", (chunk) => {
  if (resolved) return;
  stdout += chunk.toString();
  const lines = stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== 1 || !msg.result || !Array.isArray(msg.result.tools)) continue;
    resolved = true;
    clearTimeout(timeout);
    const names = msg.result.tools.map((t) => t.name).sort();
    const expectedSorted = [...EXPECTED].sort();
    const ok = JSON.stringify(names) === JSON.stringify(expectedSorted);
    console.log("Tools registered:", names.join(", "));
    proc.kill();
    if (!ok) {
      console.error("FAIL: expected", expectedSorted, "got", names);
      process.exit(1);
    }
    console.log("PASS: all 7 tools registered.");
    process.exit(0);
  }
});

proc.on("error", (err) => {
  if (resolved) return;
  resolved = true;
  clearTimeout(timeout);
  console.error("FAIL: failed to spawn server:", err.message);
  process.exit(1);
});

proc.on("exit", (code, signal) => {
  if (resolved) return;
  resolved = true;
  clearTimeout(timeout);
  console.error(`FAIL: server exited (code=${code}, signal=${signal}) before tools/list response`);
  process.exit(1);
});

const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n";
proc.stdin.write(req);
