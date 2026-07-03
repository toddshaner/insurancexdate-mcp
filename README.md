# InsuranceXDate MCP

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the [InsuranceXDate](https://www.insurancexdate.com) workers'-comp prospect database and SERFF rate-filing API. Works with any MCP client — Claude Desktop, Cursor, Continue, Zed, Cline, or a custom client built on the MCP SDK.

> Unofficial third-party client. Not affiliated with InsuranceXDate. MIT licensed. Personal project — PRs welcome but no SLA on response times.

Built on `@modelcontextprotocol/sdk` v1.29, Node 20+. Ships as both a pre-packaged Anthropic [`.mcpb` Desktop Extension](https://www.anthropic.com/engineering/desktop-extensions) for one-click install on Claude Desktop, and as plain Node source you can wire into any other MCP client's config.

## What it does

Exposes thirteen tools to MCP clients:

| Tool | Cost | Purpose |
|---|---|---|
| `search` | Free | Workers'-comp prospect search by state, renewal window, class, SIC, industry, county, carriers, carrier groups, agents, PEO providers, premium range, mod range, employee band (0-9), policy options (AR / multi-state / PEO), additional-data filters (BENEFITS / DOT / NPO / OSHA / PEO) |
| `benefits_search` | Free per upstream declaration | Form 5500 benefits-plan search via upstream MCP `datamode` 1 (retirement: participants, assets, commissions, provider name) or 2 (health/welfare: premiums, commission %, loss ratios, broker name; `fromdate`/`todate` filter the insurance renewal date). Only behavior-verified params exposed (see Q3 drift notes) |
| `match` | Free | Find a specific business by at least one of `name[]` / `fein` / `phone` / `address[]`, optionally scoped by `state`. Routes to `/api2/Match`. No additional service required per XDate support; fuzzy lookup returns the highest-score match |
| `filter` | Free | Look up valid filter values: carriers, carrier groups, classes, SIC codes, industries, counties, agents, PEO providers, NAICS codes (for `serff_search` industry filters — not WC search), SERFF insurance-type (TOI) codes, SERFF severity-type categories (response-side reference). Policy options and additional-data options are fixed `search` enums, not filter lookups |
| `company_details` | $0.25 (gated) | Full account detail by UID: `summary`, `details` (~77 fields incl. premium, payroll, mod, `signalScore`, `hazardGroup`), `carrier_history[]` (per-policy-term rows, multi-year multi-state), `_meta` field docs. Optional `scope` blocks (`contacts`/`altloc`/`tabs`/`comments`) upstream-advertised 2026-07-03, unverified in a paid response. Upstream declares 90-day same-company dedupe free (unverified) |
| `talkpoints` | $0.10 (gated) | Prospecting talking points + percentile flags by UID. Upstream declares 90-day dedupe free (unverified) |
| `serff_search` | Upstream-declared free 2026-07-03, unconfirmed (was $0.05) — still gated | SERFF rate-filing search. `carrier_naic` now optional (statewide all-carrier queries verified); severity comma-lists, `policyholders_min`, `industry_naic_prefix`, `naics3` verified 2026-07-03; `industry_naic`, `policyholders_max` upstream-declared |
| `serff_filing` | $0.10 (gated) | Full SERFF filing detail by integer `filing_id`. Upstream declares 90-day dedupe free (unverified) |
| `flagged_companies` | Free per upstream declaration | List companies you or your agency flagged (save / contacted / quoting / written / nextyear / followup / appt), with sort + pagination. Behavior-probed 2026-07-03 |
| `groups` | Free per upstream declaration | List saved company groups, incl. groups shared by agency members. Behavior-probed 2026-07-03 |
| `group_companies` | Upstream-declared free, unverified — gated | Companies in a saved group (search-format results). Executes stored account content; could not be behavior-verified (no saved groups existed to probe) |
| `saved_searches` | Free per upstream declaration | List saved prospect-search definitions. Behavior-probed 2026-07-03 |
| `run_saved_search` | Upstream-declared free, unverified — gated | Execute a saved search by id (search-format results). Executes a stored definition the wrapper cannot inspect; could not be behavior-verified (no saved searches existed to probe) |

The upstream write tools `set_flag` and `add_note` are intentionally **not** exposed: they mutate account state shared agency-wide (flags and notes propagate to sub-accounts). Exposing them would require an explicit opt-in write gate first.

## Architecture

```
MCP client (Claude Desktop, Cursor, Continue, Zed, custom...)
        │  (stdio JSON-RPC)
        ▼
  InsuranceXDate MCP server (this repo)
        │
        ├──► /api2/Search   (REST)   for `search`
        │     translates MCP-style param names (premfrom/premto/modfrom/
        │     modto/limit/offset) to REST equivalents (fromprem/toprem/
        │     frommod/tomod/pagelimit/pageon)
        │
        ├──► /api2/Match    (REST)   for `match`
        │     find-by-name endpoint (the REST `/Search` endpoint ignores
        │     `name`/`city`/`zipcode` — re-verified 2026-07-03 — so `/Match`
        │     is the correct route for find-by-identifier lookups)
        │
        └──► /api2/McpData  (MCP)    for `filter`, `company_details`,
              `talkpoints`, `serff_search`, `serff_filing`,
              `benefits_search` (upstream `search` with datamode locked
              to 1|2), `flagged_companies`, `groups`, `group_companies`,
              `saved_searches`, `run_saved_search` — passes parameters
              through using the upstream MCP's documented schema
```

The split exists because the upstream MCP at `/api2/McpData` and the REST endpoint at `/api2/Search` use different parameter naming conventions and have different filter behavior on prospect search. This wrapper bridges both surfaces with a consistent client-facing schema.

### Production-grade defaults

- **HTTP timeout:** 30s via `AbortSignal.timeout()` so slow upstream calls surface as clean errors instead of silent hangs
- **HTTP error handling:** non-2xx responses throw with status + body excerpt. Wrapper returns `isError: true` MCP results rather than wrapping error bodies as success
- **`structuredContent`:** `search` and `match` return both `content` (text JSON fallback) and typed `structuredContent` so LLMs can reason over records without re-parsing
- **URL-decode for UIDs:** company UIDs from `/api2/Search` come URL-encoded (`%2B`, `%2F`); wrapper decodes before forwarding to upstream MCP for paid lookups, which expect raw `+`/`/`
- **Schema validation:** zod-validated input on every tool (state codes uppercase regex, dates MM-DD regex, premium/mod numeric, employee band 0-9, addloptions/policyoptions enum)
- **Gated-tool switch:** set `XDATE_DISABLE_PAID=1` (also accepts `true` / `yes` / `on` / `enabled`, case-insensitive) in env to short-circuit the six gated tools — `company_details` ($0.25), `talkpoints` ($0.10), `serff_filing` ($0.10), `serff_search` (upstream-declared free 2026-07-03, unconfirmed), `group_companies` and `run_saved_search` (unverified stored-content executors) — with `isError` responses. Any other non-empty value leaves gated tools enabled and logs a startup warning to stderr. The seven always-free tools (`search`, `match`, `filter`, `benefits_search`, `flagged_companies`, `groups`, `saved_searches`) stay enabled; note the account-read tools among them still expose agency flag/pipeline lists to any connected client
- **Sensitive credential storage:** when installed via `.mcpb` on Claude Desktop, the API key flows through `user_config.api_key` with `"sensitive": true` and is stored in the OS keychain (Windows Credential Manager / macOS Keychain). On other MCP clients the server reads `INSURANCEXDATE_API_KEY` from `process.env`, so use whatever secret-handling pattern your client supports (env-var injection, secret store, etc.) — never hard-code keys in JSON config files committed to source control

## Install

The server runs as a Node.js process speaking MCP over stdio. Any MCP client can launch it. Pick the install path that matches your client.

### Prerequisites (all paths)

- Node.js 20+ (only required for Options B / C / D — Option A bundles its own runtime)
- An InsuranceXDate API key from your account's Settings → API / MCP page

### Option A: Claude Desktop (one-click `.mcpb`)

1. Download the `.mcpb` from the latest [Release](../../releases)
2. Double-click the `.mcpb` file → Claude Desktop opens an install dialog
3. Click Install
4. Paste your InsuranceXDate API key when prompted

The key is stored in the OS keychain via the manifest's `user_config.api_key` with `"sensitive": true`. No Developer Mode toggle required — `.mcpb` is designed for one-click end-user install.

> **⚠️ Windows Store / MSIX build of Claude Desktop:** Option A may not work. If Claude Desktop was installed from the Microsoft Store (MSIX, under `C:\Program Files\WindowsApps\Claude_*`), the "Install Extension" dialog can silently fail to fire — the file picker closes and nothing installs, with no error. That build also spawns MCP servers with a **stripped environment** that does not inherit your user variables. Use the config-file path instead:
>
> 1. Build from source (Option D) so you have `server\dist\index.js`.
> 2. Add an `mcpServers` entry to `%APPDATA%\Claude\claude_desktop_config.json` pointing `node` at that file. **Put the key in the entry's `env` block** — on MSIX the server will not pick up a system-set `INSURANCEXDATE_API_KEY` on its own:
>    ```json
>    {
>      "mcpServers": {
>        "insurancexdate": {
>          "command": "node",
>          "args": ["C:\\path\\to\\insurancexdate-mcp\\server\\dist\\index.js"],
>          "env": { "INSURANCEXDATE_API_KEY": "your-key-here" }
>        }
>      }
>    }
>    ```
> 3. Fully quit Claude Desktop (system tray → Quit, not just close the window), then relaunch. Note: Claude rewrites this file from memory, so if an edit seems to revert, make it while the app is fully quit.
>
> **To keep the key out of plaintext config**, point `command` at a small wrapper script (`.cmd`) that reads `INSURANCEXDATE_API_KEY` from your OS credential store / `HKCU\Environment` and then launches node — the server reads the key from its own environment, so the wrapper only needs to set it before exec. Verify after launch: the tools register under the lowercase prefix `mcp__insurancexdate__*` (from the config key), not the `.mcpb` display name.

### Option B: Cursor

Build from source (see Option D), then add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "insurancexdate": {
      "command": "node",
      "args": ["/absolute/path/to/insurancexdate-mcp/server/dist/index.js"],
      "env": {
        "INSURANCEXDATE_API_KEY": "your-key-here"
      }
    }
  }
}
```

For team setups, store the key in a secret store and inject via Cursor's env handling rather than committing the key.

### Option C: Continue, Zed, Cline, or any other MCP client with a config file

Same shape as Option B — point the client's MCP config at `server/dist/index.js` and pass `INSURANCEXDATE_API_KEY` via the env block. Consult your client's MCP-config docs for the exact file path and JSON schema (most converge on something close to Cursor's format).

For a custom client (Python, TypeScript, Go) launching the server directly, you only need:

```sh
INSURANCEXDATE_API_KEY=your-key-here node /path/to/server/dist/index.js
```

The server speaks standard MCP JSON-RPC on stdio. Anything that follows the protocol works.

### Option D: Build from source

```sh
git clone https://github.com/toddshaner/insurancexdate-mcp.git
cd insurancexdate-mcp/server
npm install
npm run build               # tsc emits server/dist/*.js (noEmitOnError prevents broken builds)
```

`server/dist/index.js` is the entry point for Options B / C and any custom client.

To repack the `.mcpb` for Claude Desktop after a source change:

```sh
cd ..                       # back to repo root
npx -y @anthropic-ai/mcpb pack .
```

For a slimmer `.mcpb`, run `npm prune --omit=dev` after build to strip TypeScript and `@types/*` from `node_modules` — `.mcpbignore` covers them anyway, but pruning is cleaner.

## Usage examples

After install, in any MCP-enabled chat client:

**Discover IL workers'-comp prospects, $250K+ annual premium, renewing in the next 60-120 days, with size-signal flags pre-filtered server-side:**

```
search(
  statelist=["IL"],
  fromdate="06-24",
  todate="08-23",
  premfrom=250000,
  addloptions=["BENEFITS","DOT","OSHA"],
  limit=50
)
```

**Find a specific company by name + state:**

```
match(state="PA", name=["Acme Logistics", "Acme Logistics Inc"])
```

**Pull rate filings for Berkley Casualty in IL, workers' comp only, broker-attack severity range:**

```
serff_search(carrier_naic=15911, state="IL", insurance_type="16.0", severity="4,5")
```

The `severity` filter takes a single value or a comma-separated list (verified server-side 2026-07-03: PA WC `severity="3,4,5"` returned 204 filings vs 105 for `"4"` alone). A single value is still exact-match, not a threshold.

**Statewide market scan — all carriers' WC filings hitting Construction, market-moving only:**

```
serff_search(state="PA", insurance_type="16.0", industry_naic_prefix=["23"], policyholders_min=1000)
```

`carrier_naic` is optional since Q3 2026 — statewide all-carrier queries verified working 2026-07-03.

**Mid-size 401(k) plans in NJ for retirement prospecting (free):**

```
benefits_search(datamode=1, statelist=["NJ"], partmin=50, partmax=500, assetmin=1000000)
```

**Health plans with a poor loss ratio renewing soon (renewal-increase wedge):**

```
benefits_search(datamode=2, statelist=["TX"], lossratiomin=85, fromdate="07-03", todate="10-01")
```

## State-data coverage

InsuranceXDate's data depth varies by state. Some filters only have data to operate on in specific states:

- **Premium data** (`premfrom` / `premto`): CO, GA, IL, NV, NJ, OK, TX, VT (8 states)
- **Mod data** (`modfrom` / `modto`): DE, MA, MN, NJ, NY, NC, OH, PA (8 states)
- **WC class code data** (`classlist`): 21 states (CA, CO, CT, DE, FL, GA, IL, KY, ME, MD, NV, NH, NJ, OH, OK, OR, PA, SC, TX, VT, VA)
- **SIC codes, employee count, carrier, sales** (most filters): 44 states (broadest)

Outside these footprints the corresponding filters have no data to operate on. This is upstream data availability, not a wrapper limitation.

## Upstream response notes (observed 2026-06-12, reconciled with Q3 metadata 2026-07-03)

XDate revises its response surfaces without versioning or notice. Three things to know from the Q2 2026 platform release, each updated where the Q3 metadata changed the picture:

- **`company_details` envelope changed.** The default response is `{ summary, user_status, details, carrier_history, _meta }` (previously `{ status, data: { details, contacts, carriers, altloc } }`). `carriers` became `carrier_history` (full per-policy-term rows, each carrying the same ~77 fields as `details` — hundreds of rows for multi-state operators, easily 1-2 MB). `contacts` and `altloc` stopped returning in the default response as of the 2026-06-12 verification; **the Q3 `scope` opt-ins were verified in a live paid response 2026-07-03**: `scope=['contacts']` returns a contacts[] array (name/email/position/phone/LinkedIn profileUrl), `scope=['altloc']` returns under the key `other_locations`, `scope=['tabs']` returns `osha`/`benefits_health`/`benefits_retirement` as top-level blocks (no `tabs` key exists in the response; no DOT block observed on a non-DOT risk). See Q3 2026 upstream drift notes below.
- **Free-tier field masking on `search`/`match` results.** `name`, `fein`, `location`, `expyear`, `carrier`, and `carriergroup` return the literal string `"available"` — present-but-withheld markers, not values. Don't treat `"available"` as data; pull `company_details` for real values.
- **The Q2 2026 DOT and NPO datasets did not appear in any API response as of the 2026-06-12 verification.** The Q3 `tabs` scope opt-in was verified 2026-07-03 to return OSHA and Form 5500 blocks; a DOT block did not appear for a company without DOT exposure, so DOT tab content remains unverified (and may additionally require the vendor's enhanced-search add-on). The `addloptions` `NPO` flag does filter server-side, but it matches companies with *linked* 990 data — including for-profit companies with affiliated foundations — and search results carry no per-record `npo` flag.

## Q3 2026 upstream drift notes (verified 2026-07-03)

XDate shipped a ["Q3 Search Menu Update"](https://www.insurancexdate.com/2026/06/23/q3-searchmenu/) on June 23, 2026: dedicated DOT (~1.2M filings) and NPO (~556K orgs) databases and reworked search menus. What that means for this wrapper, verified against the live API:

- **The dedicated DOT/NPO databases are not API-exposed.** Upstream `tools/list` has no DOT or NPO search mode (`datamode` covers only 0=WC, 1=retirement, 2=health), and the vendor KB gates DOT targeting search ("Target by DOT carrier, number of drivers or units") behind an *enhanced search add-on*. The `addloptions` DOT/NPO flags on `search` remain the API-side signal.
- **The upstream MCP's tool count grew from 7 to 13.** This wrapper now covers all 11 read tools and deliberately excludes the 2 write tools (`set_flag`, `add_note`).
- **The upstream MCP's WC search mode is still not trustworthy.** It now *partially* applies premium/mod filters but diverges from REST (verified 2026-07-03: NJ `premfrom=1M` → 2 via MCP vs 112 via REST; `modfrom=1.2` → 4,743 vs 5,609). WC search stays on the REST endpoint. The benefits modes (datamode 1/2) verified clean and are exposed via `benefits_search`.
- **Declared ≠ honored.** Upstream declares `city`/`zipcode` on its search schema, but live probes show they do not filter (dm1, 2026-07-03) — not exposed here. `planyear` returned the identical baseline for 2020/2023/2024 (unhonored); `inscommpmin`/`inscommpmax` return 0 rows for any positive bound in both NJ and TX (no usable data); `lossratiomax` is internally inconsistent (removed 1 record at 90 while `lossratiomin=95` proves ≥107 records above 90) — none exposed. Several benefits list params (`featurelist`, `providerlist`, `accountantfirmlist`, `fundfamilylist`, `healthcarriergrouplist`, `insbrokerlist`) are declared with "use the filter tool" guidance, but the filter tool rejects those lookups — no value-discovery path, not exposed. The health `instypelist` (HMO/PPO) collides with the filter tool's `instypelist` (SERFF TOI codes) — a value-domain inconsistency we document rather than inherit.
- **Pricing metadata changed.** Upstream now declares `serff_search` free (was $0.05) and 90-day same-record dedupe (repeat calls free) on `company_details`, `talkpoints`, and `serff_filing`. None of this is billing-receipt-confirmed, so `serff_search` stays behind the `XDATE_DISABLE_PAID` gate and dedupe claims are labeled unverified.
- **Account workflow tools** (`flagged_companies`, `groups`, `saved_searches` — plus gated `group_companies`, `run_saved_search`) surface the flag/group/saved-search workflows from the web UI, read-only.

## SERFF response notes

`serff_search` and `serff_filing` route to the upstream MCP and return XDate's structured shape of SERFF rate filings. A few things worth knowing before you build against the response:

### Sentiment language is policyholder-perspective, not broker-perspective

The `sentiment` field uses `bad` / `good` / `neutral` from the policyholder's point of view. The XRate web UI shows the same data with broker-perspective labels.

| API `sentiment` | XRate UI label | Meaning | Broker-side action |
|---|---|---|---|
| `bad` | Offensive | Unfavorable to policyholders (rate up, coverage cut) | Attack opportunity (filing carrier's renewal is exposed) |
| `good` | Defensive | Favorable to policyholders (rate down, expanded coverage) | Retention play (don't displace a filing helping the insured) |
| `neutral` | Neutral | Administrative, insignificant, or new program | Watch only |

A consumer reading `sentiment: "good"` and assuming it's good for the broker reaches the wrong conclusion. Document this translation in any client code that surfaces SERFF data to brokers.

### `severity_types` observed values

Filings can carry multiple. Use as a client-side post-fetch filter:

`RATE_CHANGE`, `LCM_ADJUSTMENT` (WC-specific repricing), `TIERING_REVISION` (winners/losers within a carrier book), `COVERAGE_MODIFICATION`, `UNDERWRITING_REVISION` (eligibility shifts), `ADMINISTRATIVE` (typically skip), `NEW_PROGRAM`, `MARKET_EXIT` (carrier exiting line/state/segment), `DIVIDEND_PLAN`.

### What `serff_filing` returns vs. what's NOT in the response

`serff_filing` surfaces structured fields suitable for programmatic triage at scale, but is curated rather than exhaustive. Verified empirically against filing 21434 (Berkley Casualty IL WC, public SERFF tracking BNIC-134422662):

**Structured and reliable:**

- `carrier_names` + `naic_codes` — full per-paper list when a filing covers a multi-paper carrier group
- `disproportionately_affected` — text array describing the harmed papers and class codes (e.g., `"Carolina Casualty Insurance Company (CCIC) facing a 22.4% increase"`); explicit % values for the harmed direction
- `affected_naics` — array of NAICS sector codes hit by the filing
- `actuarial_justifications` — short summary bullets of the carrier's stated reasoning
- `key_coverage_changes` — coverage form / endorsement changes
- `narrative` — pre-shaped markdown text (multiple labeled sections, written for downstream broker-attack use cases, not actuarial prose)

**NOT in the response (manual XRate UI or SERFF Filing Access required):**

- **Per-tier % impacts for favorable-direction papers.** The response itemizes the harmed direction; the full per-tier table is UI-only. (For filing 21434 verified 2026-04-26: API surfaced CCIC +22.4% and BCC +18.1%; UI also exposes KRIC +6.8%, StarNet -0.6%, MECC -12.2%.)
- **Per-paper Loss Cost Multiplier (LCM) values.** UI shows the new LCM alongside the % impact — the underlying repricing mechanism. API's `actuarial_justifications` references LCM alignment qualitatively but doesn't expose values per paper.
- **Specific reallocation movement rates.** Carriers using a multi-paper reallocation strategy (move accounts between papers to mask the headline rate impact) disclose specific transition % values in the UI (e.g., "45% of CCIC renewals to BCC, 30% of BCC renewals to KRIC"). API narrative references "reallocation" qualitatively but doesn't expose these as structured fields.
- **Per-paper policyholder counts.** UI breaks the affected-policyholder count down by paper. API gives total policyholders but not the per-paper distribution.
- **Full filing memorandum / actuarial exhibits.** Only the 3-bullet `actuarial_justifications` summary is in the response.
- **Parent carrier-group identifier.** The response carries per-paper NAICs but no group-level ID; group-level lookups require a separate `filter` call enumerating groups.
- **Class codes as a structured array.** Class codes appear inside `disproportionately_affected` as unstructured text — regex-parseable, but not a typed field.

If you're building an automated pipeline that depends on the full per-tier table or actuarial exhibits, plan for a manual SERFF Filing Access lookup as a final step. The API gets you ~3.5 of 4 things you'd want for programmatic triage; the last 0.5 still requires a manual read.

### NAICS code formatting

`affected_naics` returns 3-digit raw integers (`[238, 482, 485, 711]`). The XRate UI displays the same codes 4-digit zero-padded (`0238`, `0482`, etc.). Same codes, different formats — normalize before comparison if you parse both surfaces.

## Development

### Project structure

```
.
├── manifest.json             # .mcpb manifest (Node type, user_config keychain, 13 tools)
├── .mcpbignore               # excludes src/, devDeps, source maps from the bundle
├── LICENSE                   # MIT
├── README.md                 # this file
├── CHANGELOG.md              # version history
└── server/
    ├── package.json          # @modelcontextprotocol/sdk + zod runtime; tsc + types as devDeps
    ├── tsconfig.json         # strict + noEmitOnError
    └── src/
        ├── index.ts          # MCP server entry — registers tools, stdio transport
        ├── xdate-client.ts   # REST + MCP HTTP clients with param translation, URL decoding, timeout, error handling
        └── tools.ts          # Tool zod schemas, handler factory, paid-tool gate
```

### Build, test, pack

```sh
cd server
npm install
npm run build               # tsc with noEmitOnError; broken builds fail fast
npm test                    # no-network smoke test: tool registration, search schema shape, version consistency (same gate CI runs)
node dist/index.js          # manual stdio poke (set INSURANCEXDATE_API_KEY in env)
cd ..
npx -y @anthropic-ai/mcpb pack .
```

Version bumps touch three files — `server/src/index.ts` (serverInfo), `server/package.json` (use `npm version` in `server/` so the lockfile follows), and `manifest.json` — and the smoke test asserts all three agree, so a missed one fails `npm test` rather than shipping.

### Schema audit pattern

When adding or modifying a tool, validate the wrapper's schema against the upstream by curling `tools/list` directly:

```sh
curl -s -X POST https://www.insurancexdate.com/api2/McpData \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .
```

Diff every param name and type against the wrapper's zod schemas. Mismatches in name or type at the upstream surface silently as "filter not applied" symptoms — the call succeeds, the param is dropped, and the response is the unfiltered universe. The CHANGELOG documents two cases this audit caught (`serff_search`'s `naic`/`type` vs. upstream `carrier_naic`/`insurance_type`, and `search`'s `naicslist` advertised but no-op upstream).

When integrating against a 3rd-party API where you have an alternative source of truth (a public registry, a documented spec, a UI you can verify against), cross-validate at least one record end-to-end. For SERFF, public SERFF Filing Access (free) carries the same filing data and the API's `disposition_date` should match exactly. Drift between the two is itself a signal worth investigating.

## Acknowledgments

Built against the InsuranceXDate API. Their public OpenAPI spec is at https://insurancexdate.stoplight.io/docs/insurancexdate/. Reference architecture validated alongside the [openbnb-org/mcp-server-airbnb](https://github.com/openbnb-org/mcp-server-airbnb) MCPB install pattern.

## License

MIT — see [LICENSE](LICENSE).
