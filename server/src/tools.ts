/**
 * XDate tool definitions and handlers.
 *
 * Thirteen tools exposed by the wrapper. The `search` and `match` tools route
 * to REST endpoints with translated params where needed. The other eleven
 * pass through to the upstream MCP unchanged.
 *
 * Pricing — LEDGER-VERIFIED 2026-07-03 against the account's XChange usage
 * ledger (the per-call charge log in the web UI; the authoritative billing
 * record). Key mechanics the API alone cannot show: every charge draws from a
 * $5.00/month INCLUDED ALLOWANCE first, then from the prepaid XChange balance
 * (GET /api2/Account's apiBalance). apiFreeMonthly is the allowance SIZE (a
 * static $5.00), NOT a live remaining counter — so a balance-delta bracket via
 * the API detects charges only after the allowance is exhausted; the UI ledger
 * is the ground truth per call. Ledger findings (14 charges reconciled 1:1
 * against a known call sequence):
 *   - Published per-call prices are REAL and charge as listed.
 *   - serff_search: $0.05 CONFIRMED (9 calls -> 9 charges — the tools/list
 *     metadata's "FREE" claim is disproven), and NO dedupe (an identical
 *     same-day repeat was charged).
 *   - company_details/serff_filing: same-day same-record repeats were NOT
 *     charged (dedupe confirmed at same-day granularity). BUT a company last
 *     pulled 57 days earlier WAS re-charged — the advertised 90-day dedupe did
 *     not apply. Treat dedupe as same-day-verified only.
 *   - Cross-surface billing (REST /api2/Company vs MCP company_details) is
 *     INCONSISTENT: of two companies pulled on both surfaces same-day, one
 *     double-billed (an API charge posted alongside its MCP charge) and the
 *     other produced no API charge at all. Budget MCP and REST pulls of the
 *     same UID as separately billable; rely on cross-surface dedupe in
 *     neither direction.
 *   - talkpoints: $0.10 confirmed on prior-day (Jun 26-27) ledger rows, but
 *     the one fresh Jul 3 talkpoints call produced NO visible charge as of
 *     the readback — unresolved (posting lag or changed billing); re-check.
 *   search            - Free (ledger-consistent: no charges)
 *   match             - Free (no charges)
 *   filter            - Free (no charges)
 *   benefits_search   - Free (no charges for upstream `search`)
 *   flagged_companies - Free (behavior-probed; no charges)
 *   groups            - Free (behavior-probed; no charges)
 *   saved_searches    - Free (behavior-probed; no charges)
 *   group_companies   - GATED (unverifiable stored-content executor)
 *   run_saved_search  - GATED (unverifiable stored-content executor)
 *   serff_search      - $0.05 LEDGER-CONFIRMED, no dedupe; GATED
 *   talkpoints        - $0.10 (see talkpoints bullet above); GATED
 *   serff_filing      - $0.10 LEDGER-CONFIRMED, same-day dedupe; GATED
 *   company_details   - $0.25 LEDGER-CONFIRMED, same-day dedupe only; GATED
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
    .describe("Minimum experience mod. WORKS - translated to frommod. Mod data ONLY available in 8 states: DE, MA, MN, NJ, NY, NC, OH, PA. Outside these states this filter has no data to operate on. NJ is the ONLY state with both Premium AND Mod coverage."),
  modto: z.number().optional()
    .describe("Maximum experience mod. WORKS - translated to tomod. Same 8-state coverage as modfrom."),
  fromemp: z.number().int().min(0).max(9).optional()
    .describe("Minimum employee count band. Integer 0-9. Employee data available in 44 of 46 tracked states. Verified server-side filter 2026-04-26."),
  toemp: z.number().int().min(0).max(9).optional()
    .describe("Maximum employee count band. Integer 0-9. Same coverage as fromemp."),
  policyoptions: z.array(z.enum(["AR", "MULTISTATE", "PEO"])).optional()
    .describe("Policy-status filters. AR = Assigned Risk Only. MULTISTATE = Multi-State Only (companies operating across multiple states). PEO = PEO Only (PEO-locked accounts). Array semantic is OR — passing multiple values widens the result set. Verified server-side filter 2026-04-26."),
  addloptions: z.array(z.enum(["BENEFITS", "DOT", "NPO", "OSHA", "PEO"])).optional()
    .describe("Additional-data filters (signal-flag pre-filter). BENEFITS = with Form 5500 retirement-plan data (size proxy). DOT = with DOT/FMCSA data (transportation). NPO = with IRS 990 non-profit data. OSHA = with OSHA reporting data. PEO = with PEO data tracked. Array semantic is OR. Tip: use ['BENEFITS','DOT','OSHA'] to narrow to records with size signals. Verified server-side filter 2026-04-26. NPO caveat (verified 2026-06-12): NPO matches companies with LINKED 990 data, including for-profit companies with affiliated foundations, and search results carry no per-record npo flag (only osha/dot/benefits)."),
  limit: z.number().int().min(1).max(50).optional()
    .describe("Results per call, 1-50. WORKS - translated to pagelimit. Hard cap 50."),
  offset: z.number().int().min(0).optional()
    .describe("Page number, 0-indexed. WORKS - translated to pageon; pageon=N returns records N*limit onward (resultstats.offset echoes N*limit). Omit or pass 0 for the first page. Verified live 2026-06-12: default echoed offset 0, pageon=1 echoed offset 5 at limit 5, pageon=2 echoed offset 10."),
};

/**
 * benefits_search passes through to the upstream MCP `search` tool with
 * datamode forced to 1 or 2. datamode 0 (workers' comp) is deliberately NOT
 * expressible here: the upstream MCP's WC mode diverges from the REST
 * endpoint (verified 2026-07-03: NJ premfrom=1M returned 2 via MCP vs 112 via
 * REST; modfrom=1.2 returned 4,743 vs 5,609) — WC search stays on the
 * REST-backed `search` tool.
 *
 * Only params that were individually behavior-verified live (or are pure
 * pagination) are exposed. Declared-but-broken params exist upstream (all
 * probed live 2026-07-03, NJ/TX result-count comparisons):
 *   - city/zipcode: declared but did not filter (dm1)
 *   - planyear: 2020/2023/2024 all returned the identical 29,183 baseline
 *   - inscommpmin/inscommpmax: any positive bound returns 0 everywhere
 *     (min=0 returns the full baseline, so the field has no usable data)
 *   - lossratiomax: removed 1 record at 90 while lossratiomin=95 proves
 *     >= 107 records sit above 90 — inconsistent, unusable
 * Shipping those would be a silent no-op/zero-op trap. List params with no
 * API value-discovery path (featurelist, providerlist, accountantfirmlist,
 * fundfamilylist, healthcarriergrouplist, insbrokerlist) and the HMO/PPO
 * instypelist (the filter tool's instypelist returns SERFF TOI codes — a
 * different value domain) are also not exposed.
 */
export const BenefitsSearchSchema: Shape = {
  datamode: z.union([z.literal(1), z.literal(2)])
    .describe("REQUIRED. 1 = retirement plans (401k/pension from Form 5500: filter by participants, assets, commissions, provider/accountant names). 2 = health/welfare plans (medical/dental/life from Form 5500: filter by insurance premiums, commission %, loss ratios, broker name). Workers' comp is NOT available here — use the `search` tool."),
  statelist: z.array(STATE_CODE).optional()
    .describe("Two-letter state codes, uppercase, e.g. ['NJ']. Verified server-side 2026-07-03."),
  name: z.string().optional()
    .describe("Company name search, partial match. Verified server-side on datamode 1 2026-07-03 (NJ 29,183 -> 277 for 'school'); datamode 2 verified same day."),
  fromdate: MM_DD.optional()
    .describe("Window start, MM-DD. On datamode 2 filters the insurance renewal date (insxdate) per upstream docs; datamode 1 semantics undocumented upstream. Behavior-verified on datamode 2 2026-07-03."),
  todate: MM_DD.optional()
    .describe("Window end, MM-DD. See fromdate."),
  partmin: z.number().int().optional()
    .describe("Minimum plan participants. Verified server-side on datamode 1 2026-07-03 (NJ 29,183 -> 514 at 1000)."),
  partmax: z.number().int().optional()
    .describe("Maximum plan participants. Verified server-side 2026-07-03 (NJ 29,183 -> 14,506 at 10)."),
  assetmin: z.number().int().optional()
    .describe("[Retirement] Minimum total plan assets, dollars. Verified server-side on datamode 1 2026-07-03 (NJ 29,183 -> 416 at $100M)."),
  assetmax: z.number().int().optional()
    .describe("[Retirement] Maximum total plan assets, dollars. Verified server-side 2026-07-03 (NJ 29,183 -> 8,191 at $100K)."),
  commmin: z.number().int().optional()
    .describe("[Retirement] Minimum commission dollars. Verified server-side 2026-07-03 (NJ 29,183 -> 5,843 at $10K)."),
  commmax: z.number().int().optional()
    .describe("[Retirement] Maximum commission dollars. Verified server-side 2026-07-03 (NJ 29,183 -> 24,178 at $10K)."),
  inspremmin: z.number().int().optional()
    .describe("[Health] Minimum insurance premium, dollars. Verified server-side on datamode 2 2026-07-03 (NJ 1,884 -> 1,015 at $1M)."),
  inspremmax: z.number().int().optional()
    .describe("[Health] Maximum insurance premium, dollars. Verified server-side 2026-07-03 (NJ 1,884 -> 495 at $100K)."),
  lossratiomin: z.number().optional()
    .describe("[Health] Minimum loss ratio percentage. Verified server-side on datamode 2 2026-07-03 (NJ 1,884 -> 340 at 50, -> 107 at 95). High loss ratio = renewal-increase wedge. Note: only lossratioMIN is exposed — the upstream lossratiomax proved inconsistent in live probes and commission-% filters returned zero rows for any positive bound, so those are not exposed."),
  provname: z.string().optional()
    .describe("[Retirement] Service-provider name search, partial match. Verified server-side 2026-07-03 (NJ 29,183 -> 520 for 'fidelity')."),
  brokername: z.string().optional()
    .describe("[Health] Broker name search, partial match. Verified server-side 2026-07-03 (NJ 1,884 -> 60 for 'aon')."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Records per page, 1-100 (default 50) per upstream schema 2026-07-03."),
  offset: z.number().int().min(0).optional()
    .describe("RECORDS TO SKIP (record-skip pagination per upstream schema 2026-07-03) — NOT the page number used by the WC `search` tool. Page with offset 0, 50, 100... at limit 50; compare _meta.pagination.total to know when to stop."),
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
    "naicslist",
    "instypelist",
    "severitylist",
  ])
    .describe("Filter param to look up. WC search params: countylist, classlist, siclist, industrylist, carrierlist, carriergrouplist, agentlist, peolist. SERFF params (added Q3 2026): naicslist = NAICS codes with descriptions, a candidate value source for serff_search's industry_naic / naics3 / industry_naic_prefix filters — NOT accepted by the WC search tool (the REST endpoint ignores NAICS, re-verified 2026-07-03; use industrylist or siclist for WC search); instypelist = SERFF insurance-type (TOI) codes like '16.0' Workers Comp for serff_search.insurance_type (NOT the benefits_search health plan-type field, which has no API lookup); severitylist = SERFF severity-type categories (RATE_CHANGE, MARKET_EXIT, ...) as a reference for the response-side severity_types values on serff_search filings — client-side post-fetch filter only, not an accepted argument (serff_search.severity takes numeric 1-5). policyoptions and addloptions are fixed enums on the search tool, not filter-tool lookups: policyoptions ['AR','MULTISTATE','PEO'], addloptions ['BENEFITS','DOT','NPO','OSHA','PEO']."),
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
    .describe("Federal Employer Identification Number, DIGITS ONLY — '431851748' matches, '43-1851748' returns zero results (verified live 2026-07-03). If known, FEIN match is the most precise."),
  phone: z.string().optional()
    .describe("Phone number for match (e.g. '610-837-8210')."),
};

export const CompanyDetailsSchema: Shape = {
  uid: z.string().describe("Company UID from search results"),
  scope: z.array(z.enum(["details", "carriers", "contacts", "altloc", "tabs", "comments"])).optional()
    .describe("Data blocks to include. Default ['details','carriers']. VERIFIED in paid responses 2026-07-03 — note the scope values do NOT match the response keys: 'carriers' -> carrier_history; 'altloc' -> other_locations (array of {fein,name,address,city,state,zip}); 'tabs' -> up to FOUR top-level blocks (no 'tabs' key in the response): osha ({violationCount,violationCost,inspections}), benefits_health (Form 5500 Sch A, ~50 fields), benefits_retirement (Form 5500, ~69 fields), and on DOT-flagged companies a dot array (VERIFIED live 2026-07-03: per-MCS-150-filing rows, 35 fields incl. US DOT #, Safety Rating, Power Units, Drivers, Mileage, Carrier Operation, Insurance Providers/Type, Max Coverage (x1000), Policy Num — absent on non-DOT risks). The dot block keys on the company's DOT FLAG (search results carry dot=1), NOT its industry: pest-control, pool-care, landscaping, NEMT/healthcare-transport, and other fleet operators have FMCSA registrations too — do not skip 'tabs' because a company \"isn't a trucking company\". 'contacts' -> contacts array with {name,firstname,lastname,email,position,phone,profileUrl,year} — restored via scope after disappearing from the default response in June 2026. 'comments' -> comments array (notes/flag history)."),
};

export const TalkpointsSchema: Shape = {
  uid: z.string().describe("Company UID"),
};

export const SerffSearchSchema: Shape = {
  carrier_naic: z.number().int().optional()
    .describe("Carrier NAIC code (from company_details.carrierNaic). Integer, e.g. 15911 for Berkley Cas Co. OPTIONAL since Q3 2026 — statewide all-carrier queries verified working 2026-07-03 (PA + insurance_type alone returned 369 filings)."),
  state: STATE_CODE.optional().describe("Two-letter state code, uppercase, e.g. 'IL'"),
  insurance_type: z.string().optional()
    .describe("Insurance type code (TOI). Top-level group format like '16.0' (Workers Comp), '20.0' (Commercial Auto), '05.0' (CMP). Sub-TOI format like '05.0001' (Builders Risk), '05.0002' (Businessowners). Verified working server-side 2026-04-26. Discover codes via filter(param=instypelist). Returns only filings matching the TOI."),
  severity: z.string().optional()
    .describe("Filing severity filter, '1' through '5'. Higher = more impactful; '4' and '5' are the broker-attack signal range. Single value OR comma-separated list — verified server-side 2026-07-03: PA WC severity '3,4,5' returned 204 filings vs 105 for '4' alone. A single value is still exact-match, not a threshold."),
  industry_naic: z.array(z.number().int()).optional()
    .describe("Exact-match NAICS codes tagged as affected by the filing (2-6 digit, e.g. 423310). Upstream-declared 2026-07-03, not individually behavior-verified — validate by comparing _meta.pagination.total with/without. Candidate value source: filter(param=naicslist)."),
  industry_naic_prefix: z.array(z.string()).optional()
    .describe("NAICS prefix match for sector queries (digits only, max 6; entries OR'd). Verified server-side 2026-07-03: PA all-filings 1,878 -> 641 with ['23'] (all Construction)."),
  naics3: z.array(z.string()).optional()
    .describe("3-digit NAICS subsector codes (the XRate web UI industry filter). Verified server-side 2026-07-03: PA 1,878 -> 526 with ['236'] (Construction of Buildings). OR'd with industry_naic / industry_naic_prefix."),
  policyholders_min: z.number().int().optional()
    .describe("Minimum policyholders affected — focus on broad, market-moving filings. Verified server-side 2026-07-03: PA WC 369 -> 54 at min=1000."),
  policyholders_max: z.number().int().optional()
    .describe("Maximum policyholders affected. Upstream-declared 2026-07-03, not individually behavior-verified. Upstream docs: filings with no reported policyholder count are excluded when either bound is set."),
  limit: z.number().int().min(1).max(50).optional()
    .describe("Results per page, 1-50. Default 20."),
  offset: z.number().int().min(0).optional()
    .describe("Pagination offset, 0-indexed. Default 0."),
};

export const FlaggedCompaniesSchema: Shape = {
  type: z.enum(["save", "contacted", "quoting", "written", "nextyear", "followup", "appt"]).optional()
    .describe("Filter by flag type: save (saved for later), contacted, quoting, written (won), nextyear (revisit next renewal), followup (scheduled, has appttime), appt (appointment, has appttime). Omit for all."),
  search: z.string().optional()
    .describe("Substring match against company name."),
  sort_by: z.enum(["sort-appttime", "sort-id", "lastactsort", ".sortname", "sort-xdate"]).optional()
    .describe("Sort key, values upstream-verbatim (the '.sortname' leading dot is intentional — it is the literal upstream value, do not 'fix' it). Default: sort-appttime for type=appt/followup, sort-id (newest flagged first) otherwise. lastactsort = last activity; .sortname = company name; sort-xdate = policy expiration."),
  sort_dir: z.enum(["ASC", "DESC"]).optional()
    .describe("Sort direction, default DESC."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Records per page, 1-100 (default 50) per upstream schema 2026-07-03."),
  offset: z.number().int().min(0).optional()
    .describe("Records to skip (record-skip pagination per upstream schema 2026-07-03 — not the WC search tool's page number)."),
};

export const GroupsSchema: Shape = {};

export const GroupCompaniesSchema: Shape = {
  group_name: z.string()
    .describe("Exact group name, from the groups tool."),
  owner_userid: z.number().int().optional()
    .describe("User ID of the group owner. Only needed for shared groups; defaults to the calling user."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Records per page, 1-100 (default 50) per upstream schema 2026-07-03."),
  offset: z.number().int().min(0).optional()
    .describe("Records to skip (record-skip pagination per upstream schema 2026-07-03 — not the WC search tool's page number)."),
};

export const SavedSearchesSchema: Shape = {};

export const RunSavedSearchSchema: Shape = {
  id: z.number().int()
    .describe("Saved search id, from the saved_searches tool."),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Records per page, 1-100 (default 50) per upstream schema 2026-07-03."),
  offset: z.number().int().min(0).optional()
    .describe("Records to skip (record-skip pagination per upstream schema 2026-07-03 — not the WC search tool's page number)."),
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
  benefits_search: Handler;
  match: Handler;
  filter: Handler;
  company_details: Handler;
  talkpoints: Handler;
  serff_search: Handler;
  serff_filing: Handler;
  flagged_companies: Handler;
  groups: Handler;
  group_companies: Handler;
  saved_searches: Handler;
  run_saved_search: Handler;
}

/**
 * Emergency brake: if XDATE_DISABLE_PAID is a truthy string in env, gated tools
 * return isError without hitting the network. Defense-in-depth for environments
 * where the client should only have access to free reads (e.g. evaluation,
 * demos, or untrusted MCP clients without their own confirmation gates).
 * Gated: the priced tools (company_details $0.25, talkpoints $0.10,
 * serff_filing $0.10, serff_search $0.05 — all LEDGER-CONFIRMED 2026-07-03;
 * the metadata's "serff_search is free" claim was disproven by 9 ledger
 * charges), and the two stored-content executors (group_companies,
 * run_saved_search — upstream declares them free, but they execute account
 * content the wrapper cannot inspect and could not be behavior-verified,
 * so they stay gated too).
 * Always-free tools (search, match, filter, benefits_search, flagged_companies,
 * groups, saved_searches) are always enabled — note the account-read tools
 * still expose the agency's flag/pipeline lists to any connected client.
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

/**
 * One-shot startup check: a non-empty XDATE_DISABLE_PAID outside the truthy
 * set silently fails OPEN (paid tools stay enabled), the opposite of what a
 * user setting a "safety switch" intends. Warn on stderr — never stdout on a
 * stdio MCP server. Called once from index.ts main().
 */
export function warnIfDisablePaidUnrecognized(): void {
  const raw = process.env.XDATE_DISABLE_PAID ?? "";
  const value = raw.trim().toLowerCase();
  if (value !== "" && !TRUTHY_DISABLE_VALUES.has(value)) {
    console.error(
      `XDATE_DISABLE_PAID is set to "${raw}", which is not a recognized disable value ` +
        `(accepted, case-insensitive: 1, true, yes, on, enabled). Paid tools remain ENABLED.`,
    );
  }
}

const PAID_DISABLED_RESULT: CallToolResult = {
  content: [
    {
      type: "text",
      text: "Gated XDate tools are disabled in this environment (XDATE_DISABLE_PAID is set). Gated: company_details ($0.25), talkpoints ($0.10), serff_filing ($0.10), serff_search ($0.05 — ledger-confirmed 2026-07-03, despite vendor metadata claiming free), group_companies and run_saved_search (unverified stored-content executors). Clear the 'Disable paid tools' extension setting or unset the env var to re-enable, or use the always-free tools: search, match, filter, benefits_search, flagged_companies, groups, saved_searches.",
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
    // benefits_search rides the upstream MCP `search` tool; datamode is
    // schema-constrained to 1|2 so WC traffic can never take this path.
    benefits_search: (args) => client.mcpPassthrough("search", args),
    match: requireMatchIdentifier((args) => client.match(args)),
    filter: (args) => client.mcpPassthrough("filter", args),
    company_details: gatePaid((args) => client.mcpPassthrough("company_details", args)),
    talkpoints: gatePaid((args) => client.mcpPassthrough("talkpoints", args)),
    serff_search: gatePaid((args) => client.mcpPassthrough("serff_search", args)),
    serff_filing: gatePaid((args) => client.mcpPassthrough("serff_filing", args)),
    flagged_companies: (args) => client.mcpPassthrough("flagged_companies", args),
    groups: (args) => client.mcpPassthrough("groups", args),
    group_companies: gatePaid((args) => client.mcpPassthrough("group_companies", args)),
    saved_searches: (args) => client.mcpPassthrough("saved_searches", args),
    run_saved_search: gatePaid((args) => client.mcpPassthrough("run_saved_search", args)),
  };
}

// -------- Tool descriptions (used in registerTool calls) --------

export const TOOL_DESCRIPTIONS = {
  search: "Search workers' comp prospects. Free. Supports server-side filtering on statelist, fromdate/todate (renewal window MM-DD), classlist, siclist, industrylist, countylist, carrierlist, carriergrouplist, agentlist, peolist, premium range (premfrom/premto), mod range (modfrom/modto), employee band (fromemp/toemp 0-9), policyoptions (AR/MULTISTATE/PEO), addloptions (BENEFITS/DOT/NPO/OSHA/PEO). statelist returns multi-state operators with exposure (response 'state' field is policy-primary state, NOT exposure state - cross-state results are correct hits, not a filter mismatch). Premium data only in 8 states (CO/GA/IL/NV/NJ/OK/TX/VT). Mod data only in 8 states (DE/MA/MN/NJ/NY/NC/OH/PA). NJ is the only state with both. naicslist and name are intentionally not supported here: the REST endpoint ignores both (re-verified 2026-07-03), and while the upstream MCP's WC mode does filter on them, it searches a provably smaller WC universe (NJ: 83,143 vs REST 98,651; classlist 8810: 2,550 vs 9,282 — head-to-head 2026-07-03), so routing through it would silently drop up to a sixth of the pool. For NAICS-style WC targeting use siclist/industrylist (fuller REST universe); for find-by-name use match. Field masking (observed 2026-06-12): free search/match results return the literal string 'available' for name, fein, location, expyear, carrier, and carriergroup — treat that as 'present but withheld', not a value; real values require company_details. Q3 2026 note: XDate's dedicated DOT/NPO databases (June 23, 2026 update) are not API-exposed — upstream tools/list has no DOT/NPO search mode (checked 2026-07-03) and the vendor KB gates DOT targeting search behind an 'enhanced search add-on'; the addloptions DOT/NPO flags remain the API-side signal. For Form-5500 retirement/health prospecting use benefits_search.",
  benefits_search: "Search Form 5500 benefits-plan records (free per upstream declaration, $0/call). datamode 1 = retirement plans (401k/pension): filter by participants, plan assets, commissions, provider name. datamode 2 = health/welfare plans (medical/dental/life): filter by insurance premiums, commission %, loss ratios, broker name; fromdate/todate filter the insurance renewal date. Returns companies with UIDs for company_details/talkpoints. Server-side filtering behavior-verified 2026-07-03 (see per-param notes). Pagination: limit 1-100, offset = records to skip (NOT the page number the WC search tool uses). Workers' comp is deliberately not available here — the upstream MCP's WC mode diverges from the REST endpoint (verified 2026-07-03), so WC stays on the `search` tool. Free-tier field masking applies to results like WC search.",
  match: "Free find-by-name endpoint via /api2/Match. Find a specific business by name+state/fein/phone/address (the proper find-by-name endpoint, not search). Returns the best/highest-score fuzzy match with company UID and core fields. Useful for looking up a known prospect by name before a detail pull. XDate support confirmed 2026-05-14 that Match requires no additional service; if a 401 appears, troubleshoot account/key/request state rather than treating it as a per-call paid tool or plan add-on.",
  filter: "Look up valid filter values: carriers, carriergroups, class codes, SIC codes, industries, counties, agents, PEO providers, NAICS codes (for serff_search industry filters — NOT for WC search, where the REST endpoint ignores NAICS), SERFF insurance-type (TOI) codes, and SERFF severity-type categories (response-side reference only). policyoptions and addloptions are fixed enums on the search tool, not filter-tool lookups — pass values directly to search(). Free.",
  company_details: "Full company details for a UID. Default response (observed 2026-06-12): summary (markdown top-line), user_status (CRM-style flag/appointment status, often null), details (per-field count varies by record: ~77 fields observed 2026-06-12, 46 on two records probed 2026-07-03; incl. premium, payroll, mod/renmod, carrier, agent), carrier_history[] (full per-policy-term rows across years and states — can run to hundreds of rows for multi-state operators), _meta (per-field documentation). Optional `scope` blocks VERIFIED in paid responses 2026-07-03: 'contacts' returns a contacts[] array (name/email/position/phone/LinkedIn profileUrl) — contact data is BACK via scope after vanishing from the default response in June 2026; 'altloc' returns under the key `other_locations`; 'tabs' returns osha + benefits_health + benefits_retirement as top-level blocks (no 'tabs' key), plus on DOT-flagged companies a dot[] block VERIFIED on a live trucking risk — per-MCS-150-filing rows with 35 fields (US DOT #, Safety Rating, Power Units, Drivers, Mileage, Carrier Operation, Insurance Providers/Type, Max Coverage, Policy Num); 'comments' returns a comments[] array. Cost: $0.25/call, LEDGER-CONFIRMED 2026-07-03 (charges draw from the account's $5/mo included allowance first, then the XChange balance — invisible to a balance-only check until the allowance is exhausted). Dedupe reality per the same ledger: same-day same-record repeats were free, but a company last pulled 57 days earlier was RE-CHARGED — the advertised 90-day dedupe did not apply; plan spend assuming same-day dedupe only. Saving or caching forbidden by XDate terms.",
  talkpoints: "Prospecting talking points and industry/coverage research for a UID. Returns Premium/LCM/Market-Competitiveness percentile flags with sentiment. Cost: $0.10/call, confirmed on Jun 26-27 ledger rows (charges hit the $5/mo included allowance first, then the XChange balance); note a fresh Jul 3 call produced no visible ledger charge as of the readback — unresolved, re-check next ledger read. Assume same-day dedupe only — the advertised 90-day window failed a live test on company_details. Saving or caching forbidden.",
  serff_search: "Search SERFF rate filings. Server-side filters: carrier_naic (OPTIONAL since Q3 2026 — statewide all-carrier queries verified 2026-07-03), state, insurance_type (TOI like '16.0' for WC; discover via filter param=instypelist), severity ('1'-'5', single or comma-list like '3,4,5' — comma-list verified 2026-07-03), policyholders_min (verified 2026-07-03), industry_naic_prefix and naics3 (verified 2026-07-03), industry_naic and policyholders_max (upstream-declared, not individually behavior-verified). sentiment, severity_types, and sub_type are RESPONSE fields — filter the returned filings yourself; they are NOT accepted as tool arguments (undeclared args are silently dropped, the call still succeeds, and results come back unfiltered). Pricing: $0.05/call, LEDGER-CONFIRMED 2026-07-03 (9 calls -> 9 x $0.05 charges in the account's XChange ledger; the tools/list metadata's 'FREE' claim is disproven — trust the ledger, not vendor metadata). NO dedupe: an identical same-day repeat was charged. Charges draw from the $5/mo included allowance first, then the XChange balance. Gated via XDATE_DISABLE_PAID like the other paid tools.",
  serff_filing: "Full SERFF filing details: narratives, coverage changes, actuarial justifications. Cost: $0.10/call, LEDGER-CONFIRMED 2026-07-03; a same-day same-filing repeat was NOT charged (same-day dedupe confirmed; treat the advertised 90-day window as unreliable). Charges draw from the $5/mo included allowance first. Saving or caching forbidden.",
  flagged_companies: "List companies you (or your agency) have flagged. Flag types: save, contacted, quoting, written, nextyear, followup (has appttime), appt (has appttime). Returns UIDs usable with company_details/talkpoints. Free per upstream declaration; behavior-probed 2026-07-03. Note: exposes the agency's flag/pipeline list to any connected MCP client.",
  groups: "List your saved company groups plus groups shared by other agency members. Groups are named buckets of companies for batch workflows. Call this before group_companies. Free per upstream declaration; behavior-probed 2026-07-03.",
  group_companies: "Get the companies in a saved group (same result format as search: UIDs, city, state). Upstream declares this free (2026-07-03), but it executes stored account content the wrapper cannot inspect and could not be behavior-verified on this account (no saved groups existed to probe) — gated behind XDATE_DISABLE_PAID as a precaution until observed-free evidence exists.",
  saved_searches: "List your saved prospect-search definitions (stored criteria with auto-update windows, created in the web UI). Call this before run_saved_search. Free per upstream declaration; behavior-probed 2026-07-03.",
  run_saved_search: "Execute a saved search by id (same result format as search: UIDs, city, state). Upstream declares this free (2026-07-03), but it executes a stored search definition the wrapper cannot inspect — definitions are created in the web UI and may touch add-on surfaces — and could not be behavior-verified on this account (no saved searches existed to probe). Gated behind XDATE_DISABLE_PAID as a precaution until observed-free evidence exists.",
};
