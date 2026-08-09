# Hosted deployment (AWS App Runner via Pulumi)

Deploys the remote streamable-HTTP entrypoint (`server/src/http.ts`) as one
shared HTTPS endpoint, usable as a [claude.ai organization custom
connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
so a whole Team/Enterprise org gets the tools with no per-machine installs.

The endpoint is served under a custom domain (the `domain` stack config,
e.g. `mcp.example.com`) so the connector URL survives service re-creation.
DNS is assumed to live in Cloudflare; the program creates the App Runner
domain association, the certificate-validation CNAMEs, and the subdomain
CNAME itself. Certificate issuance is asynchronous — allow a few minutes
after the first `pulumi up` before the domain serves traffic.

## One-time setup

```bash
cd deploy/pulumi
npm install
pulumi stack init prod
pulumi config set aws:region us-east-1
pulumi config set --secret apiKey    <InsuranceXDate API key>
pulumi config set --secret pathToken "$(openssl rand -hex 24)"
pulumi config set domain mcp.example.com
# Paid tools ($0.05-$0.25/call) are DISABLED by default on the shared
# instance, since every caller spends the same account balance. Opt in with:
# pulumi config set disablePaid false

# Cloudflare auth: a token with Zone:Read + DNS:Edit on the zone, via env:
export CLOUDFLARE_API_TOKEN=...
pulumi up
```

Then read the connector URL and paste it into claude.ai → Organization
settings → Connectors:

```bash
pulumi stack output connectorUrl --show-secrets
```

## Security model

There is no OAuth layer; the URL's path token is the only gate (a
"capability URL"). Treat the full URL as a credential: share it only through
the org connector config, and rotate it by re-running
`pulumi config set --secret pathToken ...` + `pulumi up` if it leaks. Every
request an attacker could make with the URL spends your InsuranceXDate
balance.

## Traffic visibility

The container writes one JSON line per request (`evt: "request"` with the
JSON-RPC methods, tool names, status, and duration) to stdout, which App
Runner forwards to CloudWatch Logs (`/aws/apprunner/insurancexdate-mcp/...`,
application log stream). Filter on `{ $.evt = "request" }` to see team usage.
