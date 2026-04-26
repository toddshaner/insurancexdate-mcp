# InsuranceXDate MCP

A TypeScript MCP server packaged as an Anthropic [`.mcpb` Desktop Extension](https://www.anthropic.com/engineering/desktop-extensions). Wraps the [InsuranceXDate](https://www.insurancexdate.com) workers'-comp prospect database and SERFF rate-filing API for use in Claude Desktop, Claude Code, and Cowork.

> Unofficial third-party client. Not affiliated with InsuranceXDate. MIT licensed. Personal project — PRs welcome but no SLA on response times.

Built on `@modelcontextprotocol/sdk` v1.29 and Anthropic's bundled Node runtime, following the April 2026 MCPB packaging conventions.

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
Claude Desktop / Cowork
        │  (stdio)
        ▼
  InsuranceXDate MCP server (this repo)
        │
        ├──► /api2/Search   (REST)   for `search`, `match`
        │     translates MCP-style param names (premfrom/premto/modfrom/
        │     modto/limit/offset) to REST equivalents (fromprem/toprem/
        │     frommod/tomod/pagelimit/pageon)
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
- **Sensitive credential storage:** API key flows through `user_config.api_key` with `"sensitive": true`, which Claude Desktop stores in the OS keychain (Windows Credential Manager / macOS Keychain) — never on disk in the bundle

## Install

### Prerequisites

- Claude Desktop (macOS or Windows). No Developer Mode required for end-user install of a pre-built `.mcpb` — the format is designed for one-click install. Developer Mode is only required for Option B (building from source and loading an unpacked extension).
- An InsuranceXDate API key from your account's Settings → API / MCP page

### Option A: install a pre-built release (no Developer Mode required)

1. Download the `.mcpb` from the latest [Release](../../releases)
2. Double-click the `.mcpb` file → Claude Desktop opens an install dialog
3. Click Install
4. Paste your InsuranceXDate API key when prompted

The key is stored in the OS keychain via the manifest's `user_config.api_key` with `"sensitive": true`.

### Option B: build from source (Developer Mode required to load unpacked)

```sh
git clone https://github.com/toddshaner/insurancexdate-mcp.git
cd insurancexdate-mcp/server
npm install
npm run build               # tsc emits server/dist/*.js (noEmitOnError prevents broken builds)
cd ..
npx -y @anthropic-ai/mcpb pack .
```

Produces `insurancexdate-1.x.x.mcpb`. Install via Settings → Extensions → Install Extension.

If you want a slimmer pack, run `npm prune --omit=dev` after build to strip TypeScript and `@types/*` from `node_modules` — `.mcpbignore` covers them anyway, but pruning is cleaner.

## Usage examples

After install, in any Claude Desktop / Cowork chat:

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

The CHANGELOG documents how this audit caught two parameter-name mismatches (one in `serff_search`, one in `search`) that were previously surfacing as "filter not applied" symptoms.

## Acknowledgments

Built against the InsuranceXDate API. Their public OpenAPI spec is at https://insurancexdate.stoplight.io/docs/insurancexdate/. Reference architecture validated alongside the [openbnb-org/mcp-server-airbnb](https://github.com/openbnb-org/mcp-server-airbnb) MCPB install pattern.

## License

MIT — see [LICENSE](LICENSE).
