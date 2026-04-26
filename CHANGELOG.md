# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.5]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.5
[1.1.4]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.4
[1.1.3]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.3
[1.1.2]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.2
[1.1.1]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.1
[1.1.0]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/toddshaner/insurancexdate-mcp/releases/tag/v1.0.0
