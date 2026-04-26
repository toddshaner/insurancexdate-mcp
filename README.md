# InsuranceXDate MCP

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the [InsuranceXDate](https://www.insurancexdate.com) workers'-comp prospect database and SERFF rate-filing API. Works with any MCP client — Claude Desktop, Cursor, Continue, Zed, Cline, or a custom client built on the MCP SDK.

> Unofficial third-party client. Not affiliated with InsuranceXDate. MIT licensed. Personal project — PRs welcome but no SLA on response times.

Built on `@modelcontextprotocol/sdk` v1.29, Node 20+. Ships as both a pre-packaged Anthropic [`.mcpb` Desktop Extension](https://www.anthropic.com/engineering/desktop-extensions) for one-click install on Claude Desktop, and as plain Node source you can wire into any other MCP client's config.

## What it does

Exposes seven tools to MCP clients:

| Tool | Cost | Purpose |
|---|---|---|
| `search` | Free | Workers'-comp prospect search by state, renewal window, class, SIC, industry, county, carriers, agents, premium range, mod range, employee band (0-9), policy options (AR / multi-state / PEO), additional-data filters (BENEFITS / DOT / NPO / OSHA / PEO) |
| `match` | Free | Find a specific business by `state` + `name[]` + optional `address[]` / `fein` / `phone`. Routes to `/api2/Match`. Some subscription tiers do not include access |
| `filter` | Free | Look up valid filter values: carriers, carrier groups, classes, SIC codes, counties, agents, PEO providers, policy options, additional-data options |
| `company_details` | $0.25 | Full account detail by UID: carrier history, mod / LCM, premium, payroll, contacts, multi-state policy footprint |
| `talkpoints` | $0.10 | Prospecting talking points + percentile flags by UID |
| `serff_search` | $0.05 | SERFF rate-filing search by `carrier_naic` (integer) + state + insurance type (TOI) + severity. v1.1.2+ uses the upstream's documented parameter names |
| `serff_filing` | $0.10 | Full SERFF filing detail by integer `filing_id` |

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
        │     find-by-name endpoint (the upstream MCP's `name` param on
        │     `search` is silently dropped at REST, so `/Match` is the
        │     correct route for find-by-identifier lookups)
        │
        └──► /api2/McpData  (MCP)    for `filter`, `company_details`,
              `talkpoints`, `serff_search`, `serff_filing`
              passes parameters through using the upstream MCP's
              documented schema (carrier_naic / insurance_type /
              severity for serff_search)
```

The split exists because the upstream MCP at `/api2/McpData` and the REST endpoint at `/api2/Search` use different parameter naming conventions and have different filter behavior on prospect search. This wrapper bridges both surfaces with a consistent client-facing schema.

### Production-grade defaults

- **HTTP timeout:** 30s via `AbortSignal.timeout()` so slow upstream calls surface as clean errors instead of silent hangs
- **HTTP error handling:** non-2xx responses throw with status + body excerpt. Wrapper returns `isError: true` MCP results rather than wrapping error bodies as success
- **`structuredContent`:** `search` returns both `content` (text JSON fallback) and typed `structuredContent` so LLMs can reason over records without re-parsing
- **URL-decode for UIDs:** company UIDs from `/api2/Search` come URL-encoded (`%2B`, `%2F`); wrapper decodes before forwarding to upstream MCP for paid lookups, which expect raw `+`/`/`
- **Schema validation:** zod-validated input on every tool (state codes uppercase regex, dates MM-DD regex, premium/mod numeric, employee band 0-9, addloptions/policyoptions enum)
- **Paid-tool gate:** set `XDATE_DISABLE_PAID=1` in env to short-circuit `company_details`, `talkpoints`, `serff_search`, `serff_filing` with `isError` responses. Defense-in-depth for environments where you want to whitelist free tools only
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

**Pull rate filings for Berkley Casualty in IL, workers' comp only, severity 4+:**

```
serff_search(carrier_naic=15911, state="IL", insurance_type="16.0", severity="4")
```

## State-data coverage

InsuranceXDate's data depth varies by state. Some filters only have data to operate on in specific states:

- **Premium data** (`premfrom` / `premto`): CO, GA, IL, NV, NJ, OK, TX, VT (8 states)
- **Mod data** (`modfrom` / `modto`): DE, MA, MN, NJ, NY, NC, OH, PA (8 states)
- **WC class code data** (`classlist`): 21 states (CA, CO, CT, DE, FL, GA, IL, KY, ME, MD, NV, NH, NJ, OH, OK, OR, PA, SC, TX, VT, VA)
- **SIC codes, employee count, carrier, sales** (most filters): 44 states (broadest)

Outside these footprints the corresponding filters have no data to operate on. This is upstream data availability, not a wrapper limitation.

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

- Per-tier % impacts for favorable-direction papers (the response only itemizes the harmed direction; the full per-tier table is UI-only)
- Full filing memorandum / actuarial exhibits
- Parent carrier-group identifier (the response carries per-paper NAICs but no group-level ID; group-level lookups require a separate `filter` call enumerating groups)
- Class codes as a structured array (they appear inside `disproportionately_affected` as unstructured text — regex-parseable, but not a typed field)

If you're building an automated pipeline that depends on the full per-tier table or actuarial exhibits, plan for a manual SERFF Filing Access lookup as a final step. The API gets you ~3.5 of 4 things you'd want for programmatic triage; the last 0.5 still requires a manual read.

### NAICS code formatting

`affected_naics` returns 3-digit raw integers (`[238, 482, 485, 711]`). The XRate UI displays the same codes 4-digit zero-padded (`0238`, `0482`, etc.). Same codes, different formats — normalize before comparison if you parse both surfaces.

## Development

### Project structure

```
.
├── manifest.json             # .mcpb manifest (Node type, user_config keychain, 7 tools)
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
node dist/index.js          # smoke test stdio (set INSURANCEXDATE_API_KEY in env)
cd ..
npx -y @anthropic-ai/mcpb pack .
```

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
