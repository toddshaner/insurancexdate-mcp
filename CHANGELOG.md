# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - Unreleased

### Added

- **Useful native search surface:** `native_search` exposes the useful 37-field subset of the 43 fields currently declared by XDate's native MCP while keeping the fuller REST-backed `search` as the recommended WC path and `benefits_search` as the behavior-verified benefits subset. It requires an explicit datamode and rejects mode-incompatible fields. Six fields that still produce no-op, zero-result, or internally contradictory behavior (`city`, `zipcode`, `planyear`, `inscommpmin`, `inscommpmax`, `lossratiomax`) remain excluded; list fields without a value lookup are labeled experimental.
- **Account status without account leakage:** experimental `account_status` reads undocumented `GET /api2/Account` but returns only `apiBalance` and `apiFreeMonthly`. Password, session, Stripe, unreliable MCP-access, nested, and all other raw fields are permanently discarded. `apiFreeMonthly` is documented as allowance size, not remaining allowance.
- **Native XDate actions:** `add_note` and `set_flag` expose the current supported native action contracts. Both are free but change agency-shared state, so they are independently default-off behind `XDATE_ENABLE_WRITES`, require `confirm=true`, and require `?writes=1` on remote connections. Calls are never automatically retried. `set_flag.appttime` is accepted only for follow-up/appointment; the vendor's contradictory prose about null/0 schedule clearing is deferred rather than guessed.
- **MCP tool annotations:** free research tools advertise read-only/idempotent behavior, metered reads advertise their billing side effect, and write tools advertise non-idempotence. `set_flag` is marked destructive because `remove` clears flags and `hide` changes record visibility.

### Verification

- Added a no-network four-mode tool registration matrix: default 9 reads, paid-only 15, writes-only 11, and paid-plus-writes 17.
- Added exact schema assertions for the guarded 37-field `native_search` surface, its required mode and integer fields, plus write flags, confirmation, and annotations.
- Added stub-only action routing tests and account-response canaries proving credential, session, and Stripe fields cannot reach MCP output.
- No live XDate mutation is part of the test suite.

## [1.4.0] — Unreleased

### Added

- **Remote streamable-HTTP entrypoint** (`server/dist/http.js`, README Option E): stateless remote MCP endpoint alongside stdio, with `/healthz` and structured diagnostics for accepted authenticated POSTs plus selected error paths. Two mutually exclusive modes: **private** (single-operator vendor key + `MCP_PATH_TOKEN` bearer capability; not per-user authentication) and **BYOK** (`MCP_BYOK=1`: no server-side vendor key; individual callers supply their own authorized credential). Exact Host and Origin allowlists are required for MCP traffic.
- **Rate limiting** (`server/src/rate-limit.ts`), both modes: per-credential token bucket (`MCP_RATE_LIMIT_PER_MIN`, default 60/min) charging one token per JSON-RPC request carried — a batch of N costs N. BYOK adds a host-wide backstop across all keys (`MCP_GLOBAL_RATE_LIMIT_PER_MIN`, default 10× per-key); key-level denials never charge the host bucket, and host-level denials never mint per-key buckets. Bucket map hard-capped (idle-first eviction, LRU fallback). Set-but-invalid limit values refuse to start instead of failing open.
- **Default-deny paid tools** across stdio and HTTP: gated tools are absent from `tools/list` unless the operator explicitly sets `XDATE_DISABLE_PAID=0`; HTTP callers must also put `?paid=1` on the connection URL. Blank, true, and unrecognized settings remain disabled, so configuration errors fail closed.
- **Example AWS deployment** (`deploy/pulumi/`): App Runner + ECR + SSM + Cloudflare DNS, `.env`-driven. Auto-scaling defaults to one instance (`MCP_MAX_INSTANCES`) to bound concurrency; an optional account-wide AWS Budget sends alerts but neither setting caps spend. Secret rotation rolls a new revision, SSM policy attachment is an explicit service dependency, paid tools default off in both HTTP modes, ECR scans on push with immutable tags, and `MCP_STACK` is mandatory. AWS says App Runner is no longer open to new customers, so the stack is limited to accounts with existing access.
- **Tests**: limiter unit suite (injected clock), HTTP integration suite (real server per test, localhost only), and Pulumi-mocks deploy suite (no cloud, no docker), all wired into `npm test` and CI.

### Fixed

- Malformed percent-encoding in the request path (e.g. `POST /mcp/%`) crashed the HTTP server process via an unhandled `URIError`; decode is now non-throwing and the handler has a catch-all (one crafted request was a remote DoS).

### Changed

- `createServer()` factory extracted to `server/src/server.ts`, shared by both entrypoints. Stdio now exposes the seven free tools by default; the full 13-tool contract requires explicit operator opt-in with `XDATE_DISABLE_PAID=0`.
- Package metadata moved to 1.4.0 for the new remote entrypoint. CI now uses read-only permissions, commit-pinned actions, an exact MCPB CLI version, production dependency audit gates, and archive-content assertions that reject deployment, test, review, and secret-bearing files.
- Truthy env/param parsing unified behind one exported `isTruthy()` (`"1"/"true"/"yes"/"on"/"enabled"`, case-insensitive); `?paid=` now accepts the same set as every other flag.

## [1.3.5] — 2026-07-03

Pricing corrected against the account's XChange usage ledger (per-call charge log in the web UI): the day's 14 ledger charges were reconciled against a known ~23-call sequence, superseding the v1.3.4 balance-delta interpretation. Two absences remain unexplained (a fresh talkpoints call and one company's REST pulls produced no charges) and are flagged below rather than smoothed over. Also broadened the DOT-tab guidance from "trucking" to DOT-flagged (fleet operators in any industry).

### Corrected (v1.3.4's "$0.00 observed" was wrong)

- **Charges are real and match the published prices** — they draw from a $5.00/month included allowance FIRST, then the XChange balance. `apiFreeMonthly` is the allowance size (static), not a remaining counter, so the v1.3.4 API balance bracket could not see them. The UI ledger is the authoritative per-call record.
- **serff_search: $0.05/call LEDGER-CONFIRMED** (9 calls → 9 × $0.05 charges). The tools/list metadata's "FREE" declaration is disproven. Also **NO dedupe** — an identical same-day repeat was charged.
- **Dedupe is same-day-verified only**: same-day same-record repeats of company_details (6+ calls → 3 charges, one per unique company) and serff_filing (2 calls → 1 charge) were free, but a company last pulled 57 days earlier WAS re-charged — the advertised 90-day window did not apply.
- **Cross-surface billing is inconsistent, not cleanly dedupe-or-not**: two companies were pulled on both surfaces same-day, yet exactly one API-source Company charge posted — one company double-billed across surfaces while the other's REST pulls were free, and the ledger rows carry no company id to say which. Budget MCP and REST pulls of the same UID as separately billable.
- **talkpoints**: $0.10 confirmed on prior-day (Jun 26-27) ledger rows; the one fresh Jul 3 talkpoints call produced NO visible ledger charge as of the readback — unresolved (posting lag or changed billing), flagged in the description for re-check.
- All pricing/dedupe description text updated accordingly (tools.ts, manifest, README, CONTRIBUTING); serff_search title restored to "paid $0.05".

### Changed

- DOT-tab guidance de-narrowed: the `dot[]` block keys on the company's DOT FLAG (dot=1 on search results), not its industry. Pest-control, pool-care, landscaping, NEMT/healthcare-transport, and other fleet operators carry FMCSA registrations; descriptions now say never to skip 'tabs' because a prospect "isn't a trucking company".

## [1.3.4] — 2026-07-03

Pricing verified against the account's own billing counters instead of the vendor's published prices, after those proved unreliable (the pricing page and tools/list metadata disagreed on serff_search the same day). No schema or routing changes.

### Verified (our own balance-delta test, not vendor claims)

- **Discovered the live billing surface**: `GET /api2/Account` returns `apiBalance` (prepaid $) and `apiFreeMonthly` (included allowance). A run can now be bracketed (read balance → fire paid calls → read balance) so actual cost is observable — every prior enrichment receipt had to record cost as "projected, unobservable from the API."
- **Nine paid-class calls moved neither counter.** Fresh, never-pulled `company_details` and `talkpoints` on a random TX company, plus fresh `serff_search` and `serff_filing`: each a $0.0000 delta. `apiBalance` held $32.0000, `apiFreeMonthly` held $5.0000, `mcpAccess`=0, `mcpMonthlyBudget`=null, before and after. No delayed in-session posting.
- **Observed cost of every "paid" tool on this account is currently $0.00**, contradicting the published $0.25 / $0.10 / $0.05. Tool descriptions now state both the published price (retained as a caution ceiling) and the $0.00 observed figure, with the mechanism flagged unconfirmed.

### Unchanged (deliberately)

- All four gated tools stay gated. The mechanism behind the $0.00 is unconfirmed (subscription coverage vs unmetered vs off-ledger tracking vs `apiBalance` not being the charge ledger — it never moved, so it could not be positively confirmed as such), one clean pass is not a fixture-backed de-gate, and vendor metering could change. Published prices remain the worst-case ceiling.
- `precheck_calls.py` PRICES table stays at the published figures — the gate must project worst-case, not observed-best-case.

## [1.3.3] — 2026-07-03

Hybrid-routing adversarial review outcome + vendor pricing-page reconciliation. Three-lens review (hybrid advocate / defense stress-test / docs reconciler) plus decisive paired probes settled the REST-vs-MCP question with data. No routing or schema changes — the current architecture won on evidence.

### Verified

- **DOT tab content verified on a live trucking risk via the existing MCP route**: `company_details(scope=['tabs'])` on a DOT-flagged company returns a `dot[]` block — one row per MCS-150 filing, 35 fields (US DOT #, Safety Rating, Power Units, Drivers, Mileage, Carrier Operation, Insurance Providers/Type, Max Coverage (x1000), Policy Num, ...). Previous "DOT unobserved" caveat applied only to non-DOT risks. No add-on gate encountered.
- **REST `/api2/Company` probed head-to-head** (same UIDs, gated via the enrichment precheck envelope): full field-name parity on every shared block (details 46=46, dot 35=35, osha, retirement 69=69, health 50=50; contacts/carriers/altloc identical). MCP-only: summary, user_status, _meta, scope selectivity. REST-only: `tabs.related` (2 Form-5500 filing references). company_details stays MCP; REST documented as a contacts fallback.
- **REST `/api2/Search/Filter` is silently empty** — well-formed envelope, zero results for all 12 param types that return real values via MCP filter. Documented as a trap; filter stays MCP.
- details field-count varies by record: ~77 with signalScore/hazardGroup observed 2026-06-12; 46 (identical sets on both routes, no signalScore/hazardGroup) on the two records probed 2026-07-03. Descriptions now say "varies by record" instead of a fixed count.

### Changed

- **serff_search pricing: the vendor now contradicts itself in writing.** The official pricing page (checked 2026-07-03) lists $0.05/call while the upstream tools/list metadata (same day) declares it free. All wrapper text updated from "upstream-declared free, treat as possibly-paid" to the two-source conflict with paid-wins-for-safety ($0.05). Gate unchanged and further vindicated.
- 90-day dedupe wording upgraded: now vendor-documented in TWO written sources (tools/list metadata + pricing page), still not billing-receipt-verified. Cross-surface dedupe (MCP + REST pulls of the same UID) explicitly flagged as unprobed.
- set_flag/add_note exclusion rationale pinned: both are free per the pricing page; the exclusion is write-safety (agency-shared account state), not cost.
- Fixed a stale README tool-table cell that still called scope blocks "unverified" after the 1.3.1 verification.

### Rejected (with evidence, so it stays rejected)

Full reroute of company_details to REST (loses summary/user_status/_meta and scope selectivity for zero field gain); filter reroute to REST (silently-empty endpoint); always-on dual-call merge (unreceipted cross-surface dedupe → worst case double spend); a separate REST opt-in tool (the only unique REST data is 2 opaque related-filing rows).

## [1.3.2] — 2026-07-03

Doc-only: records the head-to-head REST-vs-MCP WC cross-validation that closes the "why not expose name/naicslist via the MCP path" question. MCP datamode 0 does filter on name (NJ 83,143 → 1,208) and naicslist (→ 900), but it searches a provably smaller WC universe than REST — NJ baseline 83,143 vs 98,651, renewal-window 12,353 vs 15,085, classlist 8810 2,550 vs 9,282, siclist 8051 111 vs 136, countylist essex 6,739 vs 7,413 (all probed 2026-07-03). Exposing those params would silently drop up to a sixth of the prospect pool (and ~3/4 on class-filtered queries). WC stays REST-only; NAICS-style targeting routes through siclist/industrylist; find-by-name stays on match. No schema or routing changes.

## [1.3.1] — 2026-07-03

Documentation truth-up from an independent verification pass run the same day as 1.3.0, after a distrust-the-vendor review requested re-testing every "not available" and "advertised" claim. No schema or routing changes.

### Verified (previously advertised-only)

- **`company_details.scope` blocks verified in a live paid response** (gated through the enrichment precheck envelope; one $0.25 call, dedupe-eligible): `contacts` returns a contacts[] array with name/email/position/phone/LinkedIn profileUrl — **contact data is retrievable again via scope** after disappearing from the default response in June 2026; `altloc` returns under the response key `other_locations` (not 'altloc'); `tabs` returns `osha`, `benefits_health`, and `benefits_retirement` as top-level blocks — there is no 'tabs' key in the response. No DOT block was observed on a non-DOT risk, so DOT tab content remains unverified. Descriptions updated from "advertised, unverified" to verified-with-shape, including both scope-value/response-key mismatches.
- **REST `/Search` naicslist re-probed with live NAICS ids** from filter(param=naicslist) in both integer and string form: totals unchanged (PA 184,495) — the WC-search NAICS exclusion is now backed by a same-day probe, not just the v1.1.3-era finding.
- **The six no-lookup list params re-probed directly**: upstream filter returns "Invalid param" for featurelist/providerlist/accountantfirmlist/fundfamilylist/healthcarriergrouplist/insbrokerlist — confirming the enum exclusion against the live endpoint, not just metadata.
- **No hidden DOT/NPO search mode**: datamode 3/4/5 all fall back to the WC universe (identical totals and WC-shaped result rows).

### Fixed

- `match.fein` documented as digits-only: '431851748' matches, '43-1851748' returns zero results (verified live).

## [1.3.0] — 2026-07-03

Q3 2026 upstream refresh. Driven by XDate's June 23, 2026 "Q3 Search Menu Update" (dedicated DOT/NPO databases, reworked search menus) and a full re-audit of the upstream MCP surface: `tools/list` now advertises 13 tools (was 7 at the last audit), new SERFF filters, a `scope` parameter on company_details, a `datamode` benefits-search mode, and changed pricing metadata. Every schema addition below was either individually behavior-verified live on 2026-07-03 (result-count comparisons with/without each filter) or is explicitly labeled upstream-declared/unverified in its description — nothing ships as "verified" without a logged probe.

### Added

- **`benefits_search`** — Form 5500 retirement (datamode 1) and health/welfare (datamode 2) plan search via upstream-MCP passthrough. datamode is schema-locked to 1|2: the upstream MCP's WC mode now *partially* applies premium/mod filters but diverges from REST (NJ premfrom=1M: 2 via MCP vs 112 via REST; modfrom=1.2: 4,743 vs 5,609 — verified 2026-07-03), so WC stays on the REST-backed `search`. Every exposed filter was individually behavior-verified live 2026-07-03 (NJ baselines dm1 29,183 / dm2 1,884): partmin → 514, partmax → 14,506, assetmin → 416, assetmax → 8,191, commmin → 5,843, commmax → 24,178, provname 'fidelity' → 520, name 'school' → 277 (dm1) / 46 (dm2), inspremmin → 1,015, inspremmax → 495, lossratiomin → 340 at 50 / 107 at 95, brokername 'aon' → 60, fromdate/todate 07-03..08-01 → 86. Declared-but-broken upstream params are deliberately NOT exposed, each with probe evidence: city/zipcode (no filtering, dm1), planyear (2020/2023/2024 all returned the identical baseline), inscommpmin/inscommpmax (any positive bound → 0 rows in NJ and TX; min=0 → full baseline, i.e. no usable data), lossratiomax (removed 1 record at 90 while lossratiomin=95 proves ≥107 records above 90 — inconsistent). List params with no API value-discovery path (featurelist, providerlist, accountantfirmlist, fundfamilylist, healthcarriergrouplist, insbrokerlist, the HMO/PPO instypelist) are also not exposed — the silent-no-op trap class this repo documents.
- **Account workflow tools (read-only):** `flagged_companies`, `groups`, `saved_searches` (free per upstream declaration, behavior-probed 2026-07-03, ungated) and `group_companies`, `run_saved_search` (upstream declares free, but they execute stored account content that could not be behavior-verified — this account had no saved groups/searches to probe — so both ship behind the XDATE_DISABLE_PAID gate until observed-free evidence exists). The upstream write tools `set_flag` and `add_note` are intentionally NOT exposed: they mutate account state shared agency-wide; adding them would require an explicit opt-in write gate first.
- **`serff_search` Q3 filters:** `industry_naic_prefix` (PA all-filings 1,878 → 641 with ['23'], verified), `naics3` (→ 526 with ['236'], verified), `policyholders_min` (PA WC 369 → 54 at 1000, verified), plus `industry_naic` and `policyholders_max` (upstream-declared 2026-07-03, not individually behavior-verified — labeled as such in the schema).
- **`company_details.scope`** — optional data-block selector (details/carriers/contacts/altloc/tabs/comments), upstream-advertised 2026-07-03, not yet verified in a paid response. Supersedes the 2026-06-12 observation that contacts/altloc stopped returning: they are now advertised as opt-in scope blocks. The 'tabs' block advertises DOT/OSHA/Form-5500 content; DOT may additionally require the vendor's enhanced-search add-on.
- Smoke test now asserts: 13-tool exact list, manifest.json tools[] name sync (guards the v1.1.3 stale-manifest class), exact param sets for search (21) / benefits_search (18) / serff_search (11), the 11-value filter enum, benefits_search limit cap 100, and the existing search limit cap 50 + triple-version agreement.

### Changed

- **`serff_search.carrier_naic` is now optional** — statewide all-carrier queries verified working 2026-07-03 (PA + insurance_type=16.0 alone → 369 filings). Previously required, which foreclosed a real query class.
- **`serff_search.severity` accepts comma-separated lists** — verified 2026-07-03: PA WC severity '3,4,5' → 204 vs '4' alone → 105. The old "call twice and merge" guidance is obsolete and removed from docs.
- **`filter` enum grew to 11 params:** added `naicslist` (candidate value source for serff_search's industry filters — still NOT accepted by WC search, where the REST endpoint ignores NAICS, re-verified 2026-07-03), `instypelist` (SERFF TOI codes for serff_search.insurance_type; NOT the benefits HMO/PPO field, which has no API lookup — an upstream value-domain inconsistency we document rather than inherit), and `severitylist` (reference for the response-side severity_types values; not an accepted argument anywhere).
- **Pricing metadata updates (upstream tools/list, 2026-07-03):** upstream now declares serff_search free (was $0.05) and declares 90-day same-record dedupe (repeat calls free) on company_details, talkpoints, and serff_filing. None of this is confirmed by a billing receipt, so serff_search stays behind the XDATE_DISABLE_PAID gate and every dedupe mention is labeled unverified. The paid-disabled message, manifest safety-switch text, CONTRIBUTING, and README all now carry the 7-free/6-gated split.
- Q3 2026 DOT/NPO reality documented: the dedicated DOT/NPO databases from the June 23, 2026 vendor update are not API-exposed (no DOT/NPO search mode in upstream tools/list as of 2026-07-03; vendor KB gates DOT targeting search behind an "enhanced search add-on"). The `addloptions` DOT/NPO flags remain the API-side signal.
- Scrubbed remaining internal workflow jargon from the public `match` description.

### Verification probes (2026-07-03, result-count comparisons, no payloads retained)

REST /api2/Search re-probed: name/city/zipcode still ignored (PA total 184,495 unchanged) — `match` remains the find-by-name route. Upstream MCP datamode and SERFF filter probes as itemized above. All probed endpoints are $0/free per upstream declaration; the 7 serff_search probes predate the gating decision and would cost at most $0.35 total if upstream's free declaration proves wrong.

## [1.2.0] — 2026-06-12

Driven by two inputs: a full multi-dimension external code review of the wrapper (43 confirmed findings after adversarial verification), and live verification of XDate's Q2 2026 platform release ("DOT & Non-Profit Orgs", announced 2026-06-07) against the API.

### Q2 2026 upstream verification (documented, no wrapper code required)

- **`company_details` response envelope changed upstream.** Now `{ summary, user_status, details, carrier_history, _meta }`; previously `{ status, data: { details, contacts, carriers, altloc } }`. **`contacts` and `altloc` are no longer returned.** New fields: `signalScore`, `hazardGroup`, `_meta` per-field docs. Verified live 2026-06-12 against a 492-row trucking account and a 729-row account. The wrapper's no-output-schema passthrough design absorbed the change with zero code edits — descriptions and README updated to match.
- **Q2 DOT inspection/crash/cargo and NPO 990 datasets are platform-UI only** — not present in any API response (verified against a `dot=1` trucking account). Tool descriptions now say so.
- **`addloptions` NPO caveat documented:** filters server-side (verified) but matches companies with *linked* 990 data, including for-profit companies with affiliated foundations; search results carry no per-record `npo` flag.
- **Free-tier field masking documented:** `search`/`match` results return the literal string `"available"` for name/fein/location/expyear/carrier/carriergroup.

### Fixed

- **`search.offset` was documented and validated as 1-indexed; REST `pageon` is 0-indexed.** Schema corrected to `min(0)` and description rewritten with live evidence (default echoes offset 0; `pageon=1` echoes offset 5 at limit 5). Previously the first page was unreachable with an explicit offset and `offset=1` silently skipped page one.
- **Smoke test sent a duplicate `notifications/initialized` + duplicate `tools/list` (same id 1) on every run** — the stdout handler re-parsed the entire accumulated buffer per chunk. Now consumes completed lines and keeps the trailing partial. Also fails fast on JSON-RPC error responses (was an opaque 8s timeout) and ignores stdin EPIPE on fast child death.
- **API keys containing whitespace/control characters could echo into per-call tool error text** via undici's header-validation exception. Startup now validates the key charset (`/^[!-~]+$/`) and exits with a generic message that never echoes the key.
- **Network failures surfaced as bare "fetch failed"** — `errorMessage()` now appends `err.cause` (e.g. `ENOTFOUND`).
- **HTTP 4xx/5xx from the upstream MCP was mislabeled "Network error"** — now "Error calling upstream MCP".
- **Unrecognized non-empty `XDATE_DISABLE_PAID` values silently failed open** — startup now logs a stderr warning naming the accepted values when the setting won't disable anything.
- **Paid-disabled message** no longer hardcodes `=1` and now points at the 'Disable paid tools' extension setting.

### Added

- **Smoke test now asserts the `search` input schema key set (21 params, exact equality — also proves `naicslist` stays absent), `limit.maximum === 50`, and serverInfo/package.json/manifest.json version agreement.** Guards the two regression classes that have actually bitten this repo: silent param drops and triple-version drift.
- **`server.server.onerror` handler** — MCP protocol-level errors now log to stderr instead of vanishing.
- **`npm test` script**; CI uses it. CI now uploads the packed `.mcpb` as a build artifact (single matrix leg) so releases can attach the CI-built bundle instead of a locally packed one (the v1.1.3 stale-manifest incident class).
- **`engines: node >=20`** in package.json.

### Changed

- Truncated unbounded `JSON.stringify` of upstream payloads in error messages to 500 chars (parity with the REST error path).
- Removed dead `extraHeaders` parameter from `postJson`.
- Removed internal campaign jargon from public tool descriptions ("Campaign A", "Variant B sweet spot").
- `serff_search` description now states that `sentiment`/`severity_types`/`sub_type` are response fields, not arguments — undeclared args are silently stripped by the SDK's zod parse, so passing them yields unfiltered results that look filtered.
- `match` description/title now include `address`; docs note `match` also returns `structuredContent`; README/manifest tool rows synced with the actual schemas (carrier groups, industries, PEO providers).
- manifest description no longer embeds per-release narrative (the field class that went stale in v1.1.3).

## [1.1.9] — 2026-05-14

### Changed

- **Match support confirmation reflected in connector metadata.** XDate support confirmed `/api2/Match` does not require additional service and is not a pay-per-call endpoint. The tool description now says Match is free, account-enabled, and should be treated as an account/key/request troubleshooting issue if a 401 appears, not as a plan add-on by default.
- **Match behavior documented from vendor response.** Match is fuzzy: XDate widens the search and returns the best/highest-score match.
- No API behavior changed. This is a metadata/documentation patch on top of v1.1.8.
## [1.1.8] — 2026-05-14

Metadata correction for `match` cost classification. No change to endpoint behavior.

### Fixed

- **Runtime match description now explicitly says `match` is free-class/subscription-gated, not one of the per-call paid tools.** Claude had summarized `match` as paid after the v1.1.7 install even though `/api2/Match` worked and the wrapper never routed it through the paid-tool gate.
- **Paid-disabled message now lists all free tools: `search`, `match`, and `filter`.** Previously the `XDATE_DISABLE_PAID=1` guard correctly left `match` enabled, but its error message told users to use only `search` and `filter`, creating a false cost-classification signal.

## [1.1.7] — 2026-05-14

Surgical correction to the `filter` tool's parameter list. No functional change to `search`; the affected enums remain valid on `search` as before.

### Fixed
- **`filter` tool no longer claims to accept `policyoptions` or `addloptions`.** These are fixed enums on the `search` tool (`AR`/`MULTISTATE`/`PEO` and `BENEFITS`/`DOT`/`NPO`/`OSHA`/`PEO`), not values to look up via the upstream `/api2/Search/Filter` endpoint. Including them in the filter param enum was a v1.1.3 oversight: the wrapper accepted the call, passed it upstream, and the upstream returned a confusing `Invalid param` message that lists a stale set of valid params (still includes `naicslist`). That looked like evidence of a pre-v1.1.3 server during a 2026-05-14 stack-verification pressure test. Filter's valid params are now: countylist, classlist, siclist, industrylist, carrierlist, carriergrouplist, agentlist, peolist. Search semantics unchanged — pass `policyoptions` and `addloptions` directly to `search()`.

### Notes
- Surfaced 2026-05-14 during XDate connector troubleshooting. False-positive on version mismatch traced to upstream filter error-message contents lagging the v1.1.3 schema.

## [1.1.6] — 2026-04-30

Metadata and documentation cleanup release. No tool changes, no schema changes, no transport changes.

### Changed
- **Search and filter descriptions now describe the current working field surface in present tense.** Removed stale "v1.1.3 schema" phrasing from the `.mcpb` manifest and runtime tool descriptions.
- **`naicslist` is explicitly documented as intentionally unexposed** because the upstream REST endpoint ignores it. Users should use `industrylist` or `siclist` instead.
- **`serff_search` docs now describe the upstream parameter names without version-gated wording.** This keeps the README and runtime descriptions accurate for new installs.
- **Package and runtime metadata aligned to v1.1.6** so `manifest.json`, `server/package.json`, `server/package-lock.json`, and the MCP server's reported version agree.

## [1.1.5] — 2026-04-26

Polish release based on a second external code review pass on v1.1.4. Three small guardrail and documentation fixes; no schema changes, no new tools, no transport or protocol changes.

### Changed
- **`XDATE_DISABLE_PAID` env var now accepts the standard truthy set, not only `"1"`.** A user entering `"true"`, `"yes"`, `"on"`, or `"enabled"` (case-insensitive, whitespace-trimmed) into the install-dialog `disable_paid_tools` field now disables paid tools as the field label promises. Previously, only the literal string `"1"` worked; any other value silently kept paid tools enabled — the opposite of what a user reading "safety switch" would reasonably expect. Manifest field description updated to enumerate the accepted values.
- **`severity` parameter on `serff_search` clarified as exact-match, not a threshold**, in both the schema description (`tools.ts`) and the README usage example. Earlier copy said "severity 4+" which implied threshold behavior; the upstream actually treats it as exact match (verified empirically: `severity="4"` returns only severity-4 filings). Doc now states the behavior plainly and notes the workaround (call twice and merge, or omit and filter response-side) for the broker-attack 4-and-5 range.

### Fixed
- **CHANGELOG reference-link block** at the bottom now includes `[1.1.4]` and `[1.1.5]`. The v1.1.4 release shipped without re-attaching the reference link; Keep-a-Changelog style expects the full ladder.

## [1.1.4] — 2026-04-26

Hardening release based on external code review feedback. No new tools; all changes are validation tightening, install-surface improvements, and doc fixes.

### Added
- **`disable_paid_tools` user_config option** in the `.mcpb` manifest. End users on Claude Desktop can now toggle the paid-tool safety switch from the install dialog without setting an env var manually. When set to `"1"`, the four paid endpoints (`company_details`, `talkpoints`, `serff_search`, `serff_filing`) return an `isError` response without making any network call. Defense-in-depth for evaluation, demos, or any context where only the free tools (`search`, `match`, `filter`) should be exposed. Internally wired through `XDATE_DISABLE_PAID` env var (which still works directly for non-`.mcpb` installs).
- **CI tools-list smoke test.** The `Build` workflow now spawns the built server, sends a `tools/list` JSON-RPC request, and asserts the response includes all 7 expected tool names. Catches regressions where the server boots but fails to register tools properly.

### Changed
- **`match` tool now rejects calls with no identifier.** Every field on `MatchSchema` is `.optional()` because the upstream `/api2/Match` endpoint accepts any of name / fein / phone / address as the lookup key. Calling `match()` or `match({state:"IL"})` previously hit the upstream and either returned the full state universe or surfaced a confusing error. The wrapper now short-circuits with a clean `isError` response naming the required fields. (Implemented as a runtime guard rather than zod `.refine()` because the MCP SDK's `registerTool` accepts a `ZodRawShape`, not a constructed `ZodObject`.)
- **`search` no longer declares an `outputSchema`.** The previous declaration was permissive at the inner `data` level but strict at the top — if XDate added a top-level field, the SDK's zod validation would silently strip it from `structuredContent` (default zod behavior on unknown keys is strip, not passthrough). Removing the declaration lets `structuredContent` flow through unmodified, which matches what the original comment intended. Trade-off: weaker type-generation for downstream clients; in exchange, no risk of silently losing data XDate adds upstream.
- **README architecture diagram split** to show `match` routing to `/api2/Match` (not `/api2/Search`). Reflects the actual runtime routing.

### Fixed
- `.gitignore` now excludes `Engineering memo.md` and `*.internal.md` to prevent internal-only artifacts (engineering-share memos, etc.) from accidentally entering the public repo.

### Notes
- The v1.1.3 `.mcpb` artifact had stale embedded manifest metadata (display_name "InsuranceXDate (REST proxy)", license `UNLICENSED`, description claiming "Six tools") because it was packed before the v1.1.3 manifest reframe landed. The v1.1.4 release ships a freshly packed `.mcpb` from current source.

## [1.1.3] — 2026-04-26

### Added
- **`match` tool** — wraps `/api2/Match` for find-by-name lookups (`state` + `name[]` + optional `address[]` / `fein` / `phone`). Returns the company UID and core fields. Note: some InsuranceXDate subscription tiers do not include `/Match` access; the wrapper surfaces upstream 401 responses as clean `isError` MCP responses.
- **`siclist`** (array of integers or strings) on `search` — SIC industry codes. SIC data is available in 44 of the 46 tracked states, broader coverage than WC class codes
- **`fromemp` / `toemp`** (integer 0-9) on `search` — employee count band filter. Available in 44 states
- **`policyoptions`** enum array on `search` — `AR` (assigned risk only), `MULTISTATE` (multi-state operators only), `PEO` (PEO-affiliated accounts only). Universal coverage
- **`addloptions`** enum array on `search` — `BENEFITS` (Form 5500 retirement-plan data), `DOT` (DOT/FMCSA data), `NPO` (IRS 990 non-profit data), `OSHA` (OSHA reporting data), `PEO` (PEO data tracked). Server-side signal-flag pre-filter; OR semantics. Cuts a typical multi-state IL pool roughly 40% before pagination
- `siclist`, `policyoptions`, `addloptions` to the `filter` tool's `param` enum
- State-data coverage notes on `premfrom`/`premto` (8 states with data), `modfrom`/`modto` (8 states), and other coverage-limited filters

### Changed
- `serff_filing.filing_id` is now `integer` to match the upstream's documented schema
- `classlist` and `siclist` accept either integers or strings; the upstream YAML spec calls for integers

### Removed
- **`naicslist`** from `search` — empirically a no-op at the REST endpoint regardless of value or format. Three NAICS codes (561311, 541110, 325412) all returned the unfiltered universe of 288,220 IL records. Use `industrylist` or `siclist` instead

### Notes
This release was driven by a comprehensive audit of `/Search`, `/Match`, `/Search/Filter`, and `/Company` against the [upstream OpenAPI spec](https://insurancexdate.stoplight.io/docs/insurancexdate/) plus empirical curl probes. The audit produced a complete map of which parameters filter correctly, which are no-ops, and which require a different name than the upstream MCP advertises.

## [1.1.2] — 2026-04-26

### Fixed
- **`serff_search` parameter names corrected to match the upstream's documented schema.** Earlier versions exposed `naic` (string) and `type` (string), but the upstream MCP at `/api2/McpData` accepts `carrier_naic` (integer) and `insurance_type` (string). The wrapper's parameters were unrecognized upstream and produced unfiltered results across all values tested. Renamed and added the missing `severity` (string), `limit`, `offset` parameters
- Diagnostic methodology: caught by curling `tools/list` directly against `/api2/McpData` rather than continuing to test format variants. Documented in the README's "Schema audit pattern" section

### Impact
For a typical Campaign A WC attack lookup (Berkley NAIC 15911, IL, severity ≥ 4):
- Before fix: paginate 1,434 unfiltered results × $0.05 = $3.60 to enumerate
- After fix: 1 call × $0.05 returns the single matching filing directly
- ~70× cost reduction per attack-renewal lookup

## [1.1.1] — 2026-04-25

### Fixed
- **URL-encoded UIDs from `/api2/Search` are now decoded before forwarding to upstream MCP.** The REST endpoint returns UIDs with `%2B` and `%2F` (URL-encoded `+` and `/`), but the upstream MCP at `/api2/McpData` for `company_details` and `talkpoints` rejects them with HTTP 419 ("Page Expired"). Wrapper now URL-decodes known UID-shaped fields (`uid`, formerly `filing_id`) before forwarding. Idempotent: a UID without `%` passes through unchanged
- Caught on the first end-to-end Campaign A enrichment run. The HTTP 419 surfaced as a clean `isError` MCP response courtesy of the v1.1.0 HTTP error handling fix

## [1.1.0] — 2026-04-25

Code-review fixes from an external reviewer. Eight changes shipped together.

### Added
- **HTTP timeout** via `AbortSignal.timeout(30_000)` on every fetch. Slow upstream calls now surface as clean errors instead of looking like client disconnects
- **`structuredContent`** on `search` results — returns both text content (fallback) and typed JSON. Required adding a permissive `outputSchema` to `registerTool`; without it the SDK strips `structuredContent`
- **`XDATE_DISABLE_PAID=1`** env flag — defense-in-depth gate that returns `isError` on the four paid tools (`company_details`, `talkpoints`, `serff_search`, `serff_filing`) without making any network call. Useful in environments where you want to whitelist free tools only
- **`privacy_policies`** in manifest pointing at the InsuranceXDate privacy policy
- Schema tightening: enum on `filter.param`, regex on state codes (`^[A-Z]{2}$`), regex on date params (`^MM-DD$`)

### Fixed
- **HTTP error handling** — `postJson` now checks `response.ok` and throws on non-2xx. Earlier versions parsed the response body unconditionally, which meant a JSON 401/403/429/500 body could slip through `search` as a normal text result with no `isError` flag (silent data corruption)
- **Dropped `text/event-stream` from Accept header** in `mcpPassthrough`. The wrapper only parses JSON; advertising SSE was a capability claim it couldn't deliver
- **`tsconfig.json`** sets `noEmitOnError: true` so broken builds fail fast instead of silently emitting JS alongside TypeScript errors

### Changed
- README cleanup: removed hardcoded path examples, replaced absolute paths with `<workspace>` placeholders

## [1.0.0] — 2026-04-25

Initial public release. TypeScript MCP server. Ships as both an Anthropic `.mcpb` Desktop Extension (one-click install on Claude Desktop) and as plain Node source compatible with any MCP client.

### Added
- Six tools: `search`, `filter`, `company_details`, `talkpoints`, `serff_search`, `serff_filing`
- REST proxy for `search`: hits `/api2/Search` with translated parameter names (premfrom→fromprem, premto→toprem, modfrom→frommod, modto→tomod, limit→pagelimit, offset→pageon) and 50-result pagelimit cap to match the REST endpoint's documented behavior
- MCP passthrough for `filter`, `company_details`, `talkpoints`, `serff_search`, `serff_filing` — forwards JSON-RPC `tools/call` to `/api2/McpData` and returns the upstream `result` object
- `user_config.api_key` with `"sensitive": true` for OS-keychain credential storage (Windows Credential Manager / macOS Keychain)
- stdio transport via `@modelcontextprotocol/sdk` v1.x

[1.5.0]: https://github.com/toddshaner/insurancexdate-mcp/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/toddshaner/insurancexdate-mcp/compare/v1.3.5...v1.4.0
[1.3.5]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.3.5
[1.3.4]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.3.4
[1.3.3]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.3.3
[1.3.2]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.3.2
[1.3.1]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.3.1
[1.3.0]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.3.0
[1.2.0]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.2.0
[1.1.9]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.9
[1.1.8]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.8
[1.1.7]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.7
[1.1.6]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.6
[1.1.5]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.5
[1.1.4]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.4
[1.1.3]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.3
[1.1.2]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.2
[1.1.1]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.1
[1.1.0]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.0.0
