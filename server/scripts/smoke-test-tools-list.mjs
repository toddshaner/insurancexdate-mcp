#!/usr/bin/env node
/**
 * No-network MCP smoke test.
 *
 * Spawns the built server twice (stdio) and asserts both registration
 * contracts:
 *
 * Explicit paid mode (XDATE_DISABLE_PAID=0):
 *   1. tools/list includes exactly the expected tool names (EXPECTED);
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
 *
 * Default/free mode (XDATE_DISABLE_PAID blank or unrecognized):
 *   7. tools/list contains exactly the free tools — the gated tools are NOT
 *      registered at all (absent from the list, not present-but-refusing),
 *      so a model in free mode never considers them.
 *
 * Fails CI on any mismatch (catches regressions where the server boots but
 * registration or schema publication breaks silently).
 *
 * Uses a fake API key — the server only checks that one is present at
 * startup, not that it works upstream. tools/list never touches the network.
 *
 * Run from server/: node scripts/smoke-test-tools-list.mjs  (or: npm test)
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 8000;
const GATED = [
  "company_details",
  "group_companies",
  "run_saved_search",
  "serff_filing",
  "serff_search",
  "talkpoints",
];
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
const EXPECTED_FREE = EXPECTED.filter((name) => !GATED.includes(name));
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

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Spawns dist/index.js with extraEnv, completes the MCP handshake, and
 * resolves { serverVersion, tools } from a tools/list round-trip.
 */
function listTools(extraEnv) {
  return new Promise((resolve) => {
    const proc = spawn("node", ["dist/index.js"], {
      env: {
        ...process.env,
        INSURANCEXDATE_API_KEY: "ci-smoke-test-key",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let serverVersion;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      fail("FAIL: timeout waiting for tools/list response");
    }, TIMEOUT_MS);

    proc.stderr.on("data", (d) => process.stderr.write(d));
    // A fast child death closes stdin; without this, the write EPIPEs with an
    // uncaught stack instead of the clean "FAIL: server exited" message below.
    proc.stdin.on("error", () => {});

    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");

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
          resolved = true;
          clearTimeout(timeout);
          proc.kill();
          fail(`FAIL: JSON-RPC error (id=${msg.id}): ${JSON.stringify(msg.error)}`);
        }
        if (msg.id === 0 && msg.result) {
          serverVersion = msg.result.serverInfo?.version;
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
          continue;
        }
        if (msg.id !== 1 || !msg.result || !Array.isArray(msg.result.tools)) continue;
        resolved = true;
        clearTimeout(timeout);
        proc.kill();
        resolve({ serverVersion, tools: msg.result.tools });
        return;
      }
    });

    proc.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      fail(`FAIL: failed to spawn server: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
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
  });
}

// --- Full mode: every tool registered, schemas exact, versions in sync. ---
const full = await listTools({ XDATE_DISABLE_PAID: "0" });
if (full.serverVersion !== pkgVersion || full.serverVersion !== manifestVersion) {
  fail(
    `FAIL: version drift — serverInfo ${full.serverVersion}, package.json ${pkgVersion}, manifest.json ${manifestVersion}`,
  );
}
const names = full.tools.map((t) => t.name).sort();
const expectedSorted = [...EXPECTED].sort();
console.log("Tools registered (full mode):", names.join(", "));
if (JSON.stringify(names) !== JSON.stringify(expectedSorted)) {
  fail(`FAIL: expected ${expectedSorted.join(", ")} got ${names.join(", ")}`);
}
if (JSON.stringify(manifestToolNames) !== JSON.stringify(expectedSorted)) {
  fail(
    `FAIL: manifest.json tools[] drift.\n  expected: ${expectedSorted.join(", ")}\n  manifest: ${manifestToolNames.join(", ")}`,
  );
}
const paramSetChecks = [
  ["search", EXPECTED_SEARCH_PARAMS],
  ["benefits_search", EXPECTED_BENEFITS_PARAMS],
  ["serff_search", EXPECTED_SERFF_PARAMS],
];
for (const [toolName, expectedParams] of paramSetChecks) {
  const tool = full.tools.find((t) => t.name === toolName);
  const params = Object.keys(tool.inputSchema?.properties ?? {}).sort();
  if (JSON.stringify(params) !== JSON.stringify(expectedParams)) {
    fail(
      `FAIL: ${toolName} input schema drift.\n  expected: ${expectedParams.join(", ")}\n  got:      ${params.join(", ")}`,
    );
  }
}
const search = full.tools.find((t) => t.name === "search");
if (search.inputSchema.properties.limit.maximum !== 50) {
  fail(
    `FAIL: search limit.maximum should pin the REST pagelimit cap of 50, got ${search.inputSchema.properties.limit.maximum}`,
  );
}
const benefits = full.tools.find((t) => t.name === "benefits_search");
if (benefits.inputSchema.properties.limit.maximum !== 100) {
  fail(
    `FAIL: benefits_search limit.maximum should pin the upstream cap of 100, got ${benefits.inputSchema.properties.limit.maximum}`,
  );
}
const filterTool = full.tools.find((t) => t.name === "filter");
const filterEnum = [...(filterTool.inputSchema?.properties?.param?.enum ?? [])].sort();
if (JSON.stringify(filterEnum) !== JSON.stringify(EXPECTED_FILTER_ENUM)) {
  fail(
    `FAIL: filter param enum drift.\n  expected: ${EXPECTED_FILTER_ENUM.join(", ")}\n  got:      ${filterEnum.join(", ")}`,
  );
}

// --- Free mode: gated tools absent from tools/list, not just refusing. ---
const free = await listTools({ XDATE_DISABLE_PAID: "" });
const freeNames = free.tools.map((t) => t.name).sort();
console.log("Tools registered (free mode):", freeNames.join(", "));
if (JSON.stringify(freeNames) !== JSON.stringify([...EXPECTED_FREE].sort())) {
  fail(
    `FAIL: free mode should register exactly the free tools.\n  expected: ${EXPECTED_FREE.join(", ")}\n  got:      ${freeNames.join(", ")}`,
  );
}

const failClosed = await listTools({ XDATE_DISABLE_PAID: "unrecognized-value" });
const failClosedNames = failClosed.tools.map((t) => t.name).sort();
if (JSON.stringify(failClosedNames) !== JSON.stringify([...EXPECTED_FREE].sort())) {
  fail("FAIL: an unrecognized paid-tool setting must fail closed");
}

console.log(
  `PASS: explicit paid mode registers all ${EXPECTED.length} tools (manifest in sync), default and invalid settings register exactly ${EXPECTED_FREE.length} free tools, search/benefits_search/serff_search schemas and filter enum exact, version ${pkgVersion} consistent.`,
);
process.exit(0);
