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

There is no OAuth layer; the URL's path token is the only gate (a
"capability URL"). Treat the full URL as a credential: share it only through
the org connector config, and rotate it by changing `MCP_PATH_TOKEN` in
`.env` + `./up.sh` if it leaks. Every request an attacker could make with
the URL spends your InsuranceXDate balance.

Paid tools are disabled by default on the shared instance for the same
reason; opt back in with `XDATE_DISABLE_PAID=0` in `.env`.

## Traffic visibility

The container writes one JSON line per request (`evt: "request"` with the
JSON-RPC methods, tool names, status, and duration) to stdout, which App
Runner forwards to CloudWatch Logs (`/aws/apprunner/insurancexdate-mcp/...`,
application log stream). Filter on `{ $.evt = "request" }` to see usage.
