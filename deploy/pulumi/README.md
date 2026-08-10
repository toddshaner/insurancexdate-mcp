# Hosted deployment (AWS App Runner via Pulumi)

Deploys the remote streamable-HTTP entrypoint (`server/src/http.ts`) as one
shared HTTPS endpoint, usable as a [claude.ai organization custom
connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
so a whole Team/Enterprise org gets the tools with no per-machine installs.

The endpoint is served under a custom domain (`MCP_DOMAIN`, e.g.
`mcp.example.com`) so the connector URL survives service re-creation. DNS is
assumed to live in Cloudflare; the program creates the App Runner domain
association, the certificate-validation CNAMEs, and the subdomain CNAME
itself. Certificate issuance is asynchronous — allow a few minutes after the
first deploy before the domain serves traffic.

Configuration is entirely `.env`-driven. Always deploy through `./up.sh` —
it sources `.env` into the CLI environment so the AWS and Cloudflare
provider plugins (separate processes) see the same values as the program.

## One-time setup

```bash
cd deploy/pulumi
npm install
cp .env.example .env        # fill in every non-commented value
pulumi stack init prod      # state only; all configuration comes from .env
```

Requirements: Pulumi CLI, Docker (builds the image locally), AWS
credentials (`AWS_PROFILE` in `.env` or ambient), and a Cloudflare API
token with Zone:Read + DNS:Edit on the zone.

## Deploy

```bash
./up.sh                     # pulumi up, with .env loaded
```

Then read the connector URL and paste it into claude.ai → Organization
settings → Connectors:

```bash
./up.sh stack output connectorUrl --show-secrets
```

## Security model

Two mutually exclusive auth modes, chosen in `.env` (see `.env.example` and
the root README's Option E for details):

**Private instance** (default): there is no OAuth layer; the URL's path
token is the only gate (a "capability URL"). Treat the full URL as a
credential: share it only through the org connector config, and rotate it by
changing `MCP_PATH_TOKEN` in `.env` + `./up.sh` if it leaks. Every request
an attacker could make with the URL spends your InsuranceXDate balance.

Rotation takes effect on the `./up.sh` run itself: the service config embeds
the SSM parameter versions (`MCP_SECRETS_VERSION`), so a changed secret is a
service diff and App Runner rolls a new revision that resolves the new
values. Until that deployment finishes, the old token still answers.

**BYOK** (`MCP_BYOK=1`): the deployment stores no key anywhere (no SSM
parameters are created); each caller authenticates with their own
InsuranceXDate key per request and spends their own balance. The
`connectorUrl` output becomes a template for callers to fill in.

Paid tools ($0.05–$0.25/call) are two-layered. Per caller, connections are
**free-only unless the URL carries `?paid=1`** (the gated tools are then
listed, price-labeled, and the caller's key pays; MCP clients prompt before
each call). At the instance level, `XDATE_DISABLE_PAID` in `.env` decides
whether `?paid=1` can work at all: it defaults by mode — allowed in BYOK
(callers spend their own accounts), disallowed in private mode (every call
spends the host's key). Truthy disables, falsy enables, explicit setting
wins.

## Running a second endpoint (e.g. private + BYOK)

Each endpoint is its own stack with its own env file. The env file must set
a distinct `MCP_SERVICE_NAME` (App Runner service names are unique per AWS
account) and its own `MCP_DOMAIN`; the domain's zone may live in a different
Cloudflare account, in which case that account's `CLOUDFLARE_API_TOKEN` goes
in that env file.

```bash
cp .env.example .env.byok   # MCP_STACK=byok, MCP_BYOK=1,
                            # MCP_SERVICE_NAME=insurancexdate-mcp-byok, ...
./up.sh -e .env.byok        # auto-creates + selects the stack, then deploys
```

Set `MCP_STACK` in every env file (including `.env`) — `up.sh` selects that
stack before running, so one file's values can never deploy into another
file's stack via a stale `pulumi stack select`.

## Cost guardrails

The endpoint is directly reachable (the Cloudflare record is deliberately
unproxied — proxying would let Cloudflare read callers' keys in URLs and
headers), so assume anyone can flood it. Two caps bound what that can cost:

- **Auto-scaling is pinned to one instance** (`MCP_MAX_INSTANCES`, default
  1). App Runner's default config scales to 25 instances under load; pinned
  to one small instance, a sustained flood costs roughly $15/month at worst
  instead of ~25x that. One instance easily serves an org's MCP traffic,
  and the server's per-process rate limits stay exact instead of
  multiplying per instance.
- **Optional billing alert**: set `MCP_BILLING_ALERT_EMAIL` (and optionally
  `MCP_MONTHLY_BUDGET_USD`, default 50) to create an account-wide AWS
  monthly cost budget that emails at 80% actual / 100% forecasted spend.

Upstream InsuranceXDate spend is protected separately: private mode is
dark without the path token, BYOK spends only callers' own keys, and both
modes are rate-limited (see the root README's Option E).

## Traffic visibility

The container writes one JSON line per request (`evt: "request"` with the
JSON-RPC methods, tool names, status, and duration) to stdout, which App
Runner forwards to CloudWatch Logs (`/aws/apprunner/insurancexdate-mcp/...`,
application log stream). Filter on `{ $.evt = "request" }` to see usage.
