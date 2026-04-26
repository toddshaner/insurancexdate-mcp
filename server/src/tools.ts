/**
 * XDate tool definitions and handlers.
 *
 * Six tools matching the upstream MCP at /api2/McpData. The `search` tool routes
 * to the REST endpoint with translated params (works correctly). The other five
 * pass through to upstream MCP unchanged (already work).
 *
 * Pricing (per XDate billing):
 *   search          - Free
 *   filter          - Free
 *   serff_search    - $0.05
 *   talkpoints      - $0.10
 *   serff_filing    - $0.10
 *   company_details - $0.25
 *
 * Schemas are typed as Record<string, z.ZodTypeAny> at export to avoid TS2589
 * (deep type instantiation) when registerTool inflates ShapeOutput<Args>.
 * The runtime values still carry .describe() metadata for tool introspection.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { XdateClient } from "./xdate-client.js";

type Shape = Record<string, z.ZodTypeAny>;

// -------- Tool schemas (zod) --------

// Two-letter state code, uppercase. Loose validation: accepts any 2-letter combo.
const STATE_CODE = z.string().regex(/^[A-Z]{2}$/, "Use uppercase two-letter state code, e.g. 'IL'");
// MM-DD format, year-agnostic. XDate uses this for renewal-window filters.
const MM_DD = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, "Use MM-DD format, e.g. '06-25'");

export const SearchSchema: Shape = {
  statelist: z.array(STATE_CODE).optional()
    .describe("Two-letter state codes, uppercase, e.g. ['IL', 'CA']. IMPORTANT: returns companies with WC EXPOSURE in those states, including multi-state operators whose response 'state' field shows their policy-primary state (often a different state than queried). Cross-state results in response are NOT a filter bug — those are valid multi-state operators with exposure in your queried state. To diagnose if statelist is filtering, run the same query without statelist and compare pagination.total."),
  fromdate: MM_DD.optional()
    .describe("Start of renewal window, MM-DD format. Year-agnostic."),
  todate: MM_DD.optional()
    .describe("End of renewal window, MM-DD format. Year-agnostic."),
  classlist: z.array(z.union([z.number().int(), z.string()])).optional()
    .describe("Workers' comp class codes. YAML spec says integers; both integer (e.g. [5022]) and string ([\"5022\"]) accepted at REST. Common WC codes: 5022 (masonry), 7219 (trucking), 8810 (clerical). Class code data only available in 21 states (CA, CO, CT, DE, FL, GA, IL, KY, ME, MD, NV, NH, NJ, OH, OK, OR, PA, SC, TX, VT, VA)."),
  siclist: z.array(z.union([z.number().int(), z.string()])).optional()
    .describe("SIC industry codes. YAML spec says integers; both formats accepted. SIC data available in 44 of 46 tracked states (broader coverage than WC class codes). Verified server-side filter 2026-04-26."),
  industrylist: z.array(z.string()).optional()
    .describe("Industry names (use filter tool for valid values)"),
  countylist: z.array(z.string()).optional()
    .describe("County names (use filter tool to validate)"),
  carrierlist: z.array(z.string()).optional()
    .describe("Carrier IDs as strings (granular insurance company entities)"),
  carriergrouplist: z.array(z.string()).optional()
    .describe("Carrier group IDs as strings (parent insurance group, e.g. CHUBB LTD GRP, AMERICAN INTL GRP)"),
  agentlist: z.array(z.string()).optional()
    .describe("Agent IDs as strings. Filters by SPECIFIC agent person (granular), not by full broker network. AON's full account base will not match a single agentlist entry. Use carrierlist or carriergrouplist for higher-level filtering. Verified working at granular level 2026-04-26."),
  peolist: z.array(z.string()).optional()
    .describe("PEO provider IDs as strings"),
  premfrom: z.number().int().optional()
    .describe("Minimum annual premium dollars. WORKS - translated to fromprem before hitting REST endpoint. Premium data ONLY available in 8 states: CO, GA, IL, NV, NJ, OK, TX, VT. Outside these states this filter has no data to operate on."),
  premto: z.number().int().optional()
    .describe("Maximum annual premium dollars. WORKS - translated to toprem. Same 8-state coverage as premfrom."),
  modfrom: z.number().optional()
    .describe("Minimum experience mod. WORKS - translated to frommod. Mod data ONLY available in 8 states: DE, MA, MN, NJ, NY, NC, OH, PA. Outside these states this filter has no data to operate on. NJ is the ONLY state with both Premium AND Mod coverage (Variant B sweet spot)."),
  modto: z.number().optional()
    .describe("Maximum experience mod. WORKS - translated to tomod. Same 8-state coverage as modfrom."),
  fromemp: z.number().int().min(0).max(9).optional()
    .describe("Minimum employee count band. Integer 0-9. Employee data available in 44 of 46 tracked states. Verified server-side filter 2026-04-26."),
  toemp: z.number().int().min(0).max(9).optional()
    .describe("Maximum employee count band. Integer 0-9. Same coverage as fromemp."),
  policyoptions: z.array(z.enum(["AR", "MULTISTATE", "PEO"])).optional()
    .describe("Policy-status filters. AR = Assigned Risk Only. MULTISTATE = Multi-State Only (companies operating across multiple states). PEO = PEO Only (PEO-locked accounts). Array semantic is OR — passing multiple values widens the result set. Verified server-side filter 2026-04-26."),
  addloptions: z.array(z.enum(["BENEFITS", "DOT", "NPO", "OSHA", "PEO"])).optional()
    .describe("Additional-data filters (signal-flag pre-filter). BENEFITS = with Form 5500 retirement-plan data (size proxy). DOT = with DOT/FMCSA data (transportation). NPO = with IRS 990 non-profit data. OSHA = with OSHA reporting data. PEO = with PEO data tracked. Array semantic is OR. For Campaign A WC pre-filter, use ['BENEFITS','DOT','OSHA'] to narrow to records with size signals. Then client-side score for triple-positive ranking. Verified server-side filter 2026-04-26."),
  limit: z.number().int().min(1).max(50).optional()
    .describe("Results per call, 1-50. WORKS - translated to pagelimit. Hard cap 50."),
  offset: z.number().int().min(1).optional()
    .describe("Page number, 1-indexed. WORKS - translated to pageon. Real page-based pagination."),
};

export const FilterSchema: Shape = {
  param: z.enum([
    "countylist",
    "classlist",
    "siclist",
    "industrylist",
    "carrierlist",
    "carriergrouplist",
    "agentlist",
    "peolist",
    "policyoptions",
    "addloptions",
  ])
    .describe("Filter param to look up. One of: countylist, classlist, siclist, industrylist, carrierlist, carriergrouplist, agentlist, peolist, policyoptions, addloptions. Note: naicslist was removed in v1.1.3 (the REST endpoint does not apply this filter; use industrylist or siclist instead). policyoptions enum: AR/MULTISTATE/PEO. addloptions enum: BENEFITS/DOT/NPO/OSHA/PEO."),
  statelist: z.array(STATE_CODE).optional()
    .describe("Optional state filter (uppercase two-letter codes)"),
  search: z.string().optional()
    .describe("Optional substring filter on results"),
};

export const MatchSchema: Shape = {
  state: STATE_CODE.optional()
    .describe("Two-letter state code, uppercase. Scopes the match to a state."),
  name: z.array(z.string()).optional()
    .describe("Array of company name candidates to match against. Send multiple variations (e.g. with/without 'Inc', 'LLC') to maximize match rate."),
  address: z.array(z.string()).optional()
    .describe("Array of address candidates. Improves match precision when combined with name."),
  fein: z.string().optional()
    .describe("Federal Employer Identification Number. If known, FEIN match is the most precise."),
  phone: z.string().optional()
    .describe("Phone number for match (e.g. '610-837-8210')."),
};

export const CompanyDetailsSchema: Shape = {
  uid: z.string().describe("Company UID from search results"),
};

export const TalkpointsSchema: Shape = {
  uid: z.string().describe("Company UID"),
};

export const SerffSearchSchema: Shape = {
  carrier_naic: z.number().int()
    .describe("Carrier NAIC code (from company_details.carrierNaic). Integer, e.g. 15911 for Berkley Cas Co."),
  state: STATE_CODE.optional().describe("Two-letter state code, uppercase, e.g. 'IL'"),
  insurance_type: z.string().optional()
    .describe("Insurance type code (TOI). Top-level group format like '16.0' (Workers Comp), '20.0' (Commercial Auto), '05.0' (CMP). Sub-TOI format like '05.0001' (Builders Risk), '05.0002' (Businessowners). Verified working server-side 2026-04-26. Returns only filings matching the TOI."),
  severity: z.string().optional()
    .describe("Filing severity filter, '1' through '5'. Higher = more impactful. '4' and '5' are the broker-attack signal range. **Exact-match filter, not a threshold** — `severity='4'` returns only severity-4 filings, not 4 and 5. To capture both 4 and 5 (broker-attack range), call twice and merge response-side, or omit `severity` entirely and filter response-side. Verified working server-side 2026-04-26."),
  limit: z.number().int().min(1).max(50).optional()
    .describe("Results per page, 1-50. Default 20."),
  offset: z.number().int().min(0).optional()
    .describe("Pagination offset, 0-indexed. Default 0."),
};

export const SerffFilingSchema: Shape = {
  filing_id: z.number().int().describe("Filing ID from serff_search.filings[].filing_id. Integer (XDate's internal ID, not the public SERFF tracking number)."),
};

// -------- Output schemas --------

/**
 * No output schema is declared for `search`. The XDate REST response shape is
 * `{ status, data: { resultstats: {...}, results: [...] } }` but XDate is the
 * source of truth and may add top-level or nested fields without notice. A
 * declared zod output schema would silently strip unknown keys from
 * `structuredContent` at SDK validation time (default zod behavior on
 * unknown-key input is strip, not passthrough, and zod's `.passthrough()`
 * cannot be expressed as a `ZodRawShape` — only on a constructed ZodObject,
 * which the MCP SDK's `registerTool` doesn't accept here).
 *
 * The wrapper attaches `structuredContent` directly from the parsed REST
 * response in `xdate-client.ts#search`, so consumers receive whatever XDate
 * returns, undamaged.
 */

// -------- Handler factory --------

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export interface XdateHandlers {
  search: Handler;
  match: Handler;
  filter: Handler;
  company_details: Handler;
  talkpoints: Handler;
  serff_search: Handler;
  serff_filing: Handler;
}

/**
 * Emergency brake: if XDATE_DISABLE_PAID is a truthy string in env, paid tools
 * return isError without hitting the network. Defense-in-depth for environments
 * where the client should only have access to free reads (e.g. evaluation,
 * demos, or untrusted MCP clients without their own confirmation gates).
 * Free tools (search, match, filter) are always enabled.
 *
 * Tolerant truthy parsing: accepts "1", "true", "yes", "on", "enabled"
 * (case-insensitive, whitespace-trimmed). A user setting a "safety switch"
 * via the .mcpb install-dialog string field may reasonably enter "true" or
 * "yes" and expect that to count; v1.1.4 was strict-"1"-only and silently
 * left paid tools enabled for any other value, the opposite of the labeled
 * intent. v1.1.5 widened to the standard truthy set.
 */
const TRUTHY_DISABLE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

function paidDisabled(): boolean {
  const value = (process.env.XDATE_DISABLE_PAID ?? "").trim().toLowerCase();
  return TRUTHY_DISABLE_VALUES.has(value);
}

const PAID_DISABLED_RESULT: CallToolResult = {
  content: [
    {
      type: "text",
      text: "Paid XDate tools are disabled in this environment (XDATE_DISABLE_PAID=1). Unset the env var to re-enable, or use the free `search` and `filter` tools.",
    },
  ],
  isError: true,
};

function gatePaid(handler: Handler): Handler {
  return async (args) => {
    if (paidDisabled()) return PAID_DISABLED_RESULT;
    return handler(args);
  };
}

/**
 * Reject `match` calls that arrive with no identifier. Every field on
 * MatchSchema is `.optional()` because the upstream `/api2/Match` endpoint
 * accepts any of name / fein / phone / address as the lookup key, and there's
 * no zod-Shape way to express "at least one of these required" (zod's `.refine()`
 * lives on a constructed ZodObject, not on a ZodRawShape, and the MCP SDK's
 * registerTool wants a Shape). So we guard at runtime: an empty-bodied or
 * state-only match() call is functionally useless and would either return the
 * full state universe or surface a confusing upstream error. We short-circuit
 * with a clean isError response naming the required fields.
 */
const MATCH_IDENTIFIER_KEYS = ["name", "fein", "phone", "address"] as const;

function hasMatchIdentifier(args: Record<string, unknown>): boolean {
  for (const key of MATCH_IDENTIFIER_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
    if (Array.isArray(value) && value.some((v) => typeof v === "string" && v.trim().length > 0)) {
      return true;
    }
  }
  return false;
}

const MATCH_NO_IDENTIFIER_RESULT: CallToolResult = {
  content: [
    {
      type: "text",
      text: "match requires at least one identifier: name (array of strings), fein, phone, or address (array of strings). Calling match with only `state` (or with no args) returns no useful result.",
    },
  ],
  isError: true,
};

function requireMatchIdentifier(handler: Handler): Handler {
  return async (args) => {
    if (!hasMatchIdentifier(args)) return MATCH_NO_IDENTIFIER_RESULT;
    return handler(args);
  };
}

export function buildHandlers(client: XdateClient): XdateHandlers {
  return {
    search: (args) => client.search(args),
    match: requireMatchIdentifier((args) => client.match(args)),
    filter: (args) => client.mcpPassthrough("filter", args),
    company_details: gatePaid((args) => client.mcpPassthrough("company_details", args)),
    talkpoints: gatePaid((args) => client.mcpPassthrough("talkpoints", args)),
    serff_search: gatePaid((args) => client.mcpPassthrough("serff_search", args)),
    serff_filing: gatePaid((args) => client.mcpPassthrough("serff_filing", args)),
  };
}

// -------- Tool descriptions (used in registerTool calls) --------

export const TOOL_DESCRIPTIONS = {
  search: "Search workers' comp prospects. Free. v1.1.3 schema aligned with upstream OpenAPI spec — supports server-side filtering on statelist, fromdate/todate (renewal window MM-DD), classlist, siclist, industrylist, countylist, carrierlist, carriergrouplist, agentlist, peolist, premium range (premfrom/premto), mod range (modfrom/modto), employee band (fromemp/toemp 0-9), policyoptions (AR/MULTISTATE/PEO), addloptions (BENEFITS/DOT/NPO/OSHA/PEO). statelist returns multi-state operators with exposure (response 'state' field is policy-primary state, NOT exposure state — cross-state results are correct hits, not a filter mismatch). Premium data only in 8 states (CO/GA/IL/NV/NJ/OK/TX/VT). Mod data only in 8 states (DE/MA/MN/NJ/NY/NC/OH/PA). NJ is the only state with both. naicslist removed in v1.1.3 (use industrylist or siclist instead).",
  match: "Find a specific business by name+state/fein/phone (the proper find-by-name endpoint, not search). Returns the company UID and core fields. Useful for xdate-enrich Mode A workflows that look up a known prospect by name. Note: requires subscription tier with /Match access — may return 'unauthorized' for some API keys.",
  filter: "Look up valid filter values: carriers, carriergroups, class codes, SIC codes, industries, counties, agents, PEO providers, policyoptions, addloptions. v1.1.3 added siclist, policyoptions, addloptions to the param enum; removed naicslist (was a no-op upstream). Free.",
  company_details: "Full company details for a UID: carrier history, mod rates, premium, payroll, agents, contacts, multi-state policy footprint. Cost: $0.25/call. Saving or caching forbidden by XDate terms.",
  talkpoints: "Prospecting talking points and industry/coverage research for a UID. Returns Premium/LCM/Market-Competitiveness percentile flags with sentiment. Cost: $0.10/call. Saving or caching forbidden.",
  serff_search: "Search SERFF rate filings. v1.1.2 corrected schema (carrier_naic integer, insurance_type, severity). Server-side filters: carrier_naic, state, insurance_type (TOI like '16.0' for WC), severity (1-5). Client-side filters: sentiment, severity_types, sub_type. Cost: $0.05/call.",
  serff_filing: "Full SERFF filing details: narratives, coverage changes, actuarial justifications. Cost: $0.10/call. Saving or caching forbidden.",
};
