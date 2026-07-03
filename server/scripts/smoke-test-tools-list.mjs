#!/usr/bin/env node
/**
 * No-network MCP smoke test.
 *
 * Spawns the built server, completes the MCP initialize handshake, sends a
 * tools/list JSON-RPC request over stdio, and asserts:
 *   1. the response includes exactly the expected tool names (EXPECTED);
 *   2. the `search`, `benefits_search`, and `serff_search` input schemas each
 *      expose exactly the expected param set (catches the silent-param-drop
 *      regression class — a param missing from the published schema is
 *      stripped before it ever reaches the API);
 *   3. search's `limit` pins maximum 50 (verified REST pagelimit cap) and
 *      benefits_search's `limit` pins maximum 100 (upstream schema 2026-07-03);
 *   4. the filter tool's `param` enum matches the expected 11 values;
 *   5. manifest.json tools[] names match the registered tool names exactly
 *      (guards the v1.1.3 stale-manifest incident class);
 *   6. serverInfo.version === server/package.json === manifest.json (the
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
  "benefits_search",
  "company_details",
  "filter",
  "flagged_companies",
  "group_companies",
  "groups",
  "match",
  "run_saved_search",
  "saved_searches",
  "search",
  "serff_filing",
  "serff_search",
  "talkpoints",
];
// Exact key set of SearchSchema. Exact equality also guarantees naicslist
// (intentionally unexposed — no-op at the REST endpoint, re-verified
// 2026-07-03) stays absent from the WC search tool.
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
// Exact key set of BenefitsSearchSchema. Exact equality guarantees the
// declared-but-broken upstream params (city, zipcode, planyear,
// inscommpmin/inscommpmax, lossratiomax — all failed live verification
// 2026-07-03) and the no-value-lookup list params (featurelist, providerlist,
// accountantfirmlist, fundfamilylist, healthcarriergrouplist, insbrokerlist,
// instypelist) stay out.
const EXPECTED_BENEFITS_PARAMS = [
  "assetmax",
  "assetmin",
  "brokername",
  "commmax",
  "commmin",
  "datamode",
  "fromdate",
  "inspremmax",
  "inspremmin",
  "limit",
  "lossratiomin",
  "name",
  "offset",
  "partmax",
  "partmin",
  "provname",
  "statelist",
  "todate",
];
// Exact key set of SerffSearchSchema (Q3 2026 industry/policyholder filters).
const EXPECTED_SERFF_PARAMS = [
  "carrier_naic",
  "industry_naic",
  "industry_naic_prefix",
  "insurance_type",
  "limit",
  "naics3",
  "offset",
  "policyholders_max",
  "policyholders_min",
  "severity",
  "state",
];
// Exact value set of FilterSchema's param enum (11 values, matching the
// upstream filter enum captured 2026-07-03).
const EXPECTED_FILTER_ENUM = [
  "agentlist",
  "carriergrouplist",
  "carrierlist",
  "classlist",
  "countylist",
  "industrylist",
  "instypelist",
  "naicslist",
  "peolist",
  "severitylist",
  "siclist",
];

// Script-relative reads so this works run-from-server/ and under CI's
// working-directory: server.
const pkgVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
).version;
const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url)),
);
const manifestVersion = manifest.version;
const manifestToolNames = (manifest.tools ?? []).map((t) => t.name).sort();

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
    if (JSON.stringify(manifestToolNames) !== JSON.stringify(expectedSorted)) {
      console.error(
        "FAIL: manifest.json tools[] drift.\n  expected:",
        expectedSorted.join(", "),
        "\n  manifest:",
        manifestToolNames.join(", "),
      );
      proc.kill();
      process.exit(1);
    }
    const paramSetChecks = [
      ["search", EXPECTED_SEARCH_PARAMS],
      ["benefits_search", EXPECTED_BENEFITS_PARAMS],
      ["serff_search", EXPECTED_SERFF_PARAMS],
    ];
    for (const [toolName, expectedParams] of paramSetChecks) {
      const tool = msg.result.tools.find((t) => t.name === toolName);
      const params = Object.keys(tool.inputSchema?.properties ?? {}).sort();
      if (JSON.stringify(params) !== JSON.stringify(expectedParams)) {
        console.error(
          `FAIL: ${toolName} input schema drift.\n  expected:`,
          expectedParams.join(", "),
          "\n  got:     ",
          params.join(", "),
        );
        proc.kill();
        process.exit(1);
      }
    }
    const search = msg.result.tools.find((t) => t.name === "search");
    if (search.inputSchema.properties.limit.maximum !== 50) {
      console.error(
        "FAIL: search limit.maximum should pin the REST pagelimit cap of 50, got",
        search.inputSchema.properties.limit.maximum,
      );
      proc.kill();
      process.exit(1);
    }
    const benefits = msg.result.tools.find((t) => t.name === "benefits_search");
    if (benefits.inputSchema.properties.limit.maximum !== 100) {
      console.error(
        "FAIL: benefits_search limit.maximum should pin the upstream cap of 100, got",
        benefits.inputSchema.properties.limit.maximum,
      );
      proc.kill();
      process.exit(1);
    }
    const filterTool = msg.result.tools.find((t) => t.name === "filter");
    const filterEnum = [...(filterTool.inputSchema?.properties?.param?.enum ?? [])].sort();
    if (JSON.stringify(filterEnum) !== JSON.stringify(EXPECTED_FILTER_ENUM)) {
      console.error(
        "FAIL: filter param enum drift.\n  expected:",
        EXPECTED_FILTER_ENUM.join(", "),
        "\n  got:     ",
        filterEnum.join(", "),
      );
      proc.kill();
      process.exit(1);
    }
    proc.kill();
    console.log(
      `PASS: all ${EXPECTED.length} tools registered (manifest in sync), search/benefits_search/serff_search schemas and filter enum exact, version ${pkgVersion} consistent.`,
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
