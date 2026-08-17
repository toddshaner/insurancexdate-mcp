# Hosted deployment (AWS App Runner via Pulumi)

Deploys the remote streamable-HTTP entrypoint (`server/src/http.ts`) behind a
custom domain (`MCP_DOMAIN`, for example `mcp.example.com`). DNS must be in
Cloudflare. The program creates the App Runner domain association, certificate
validation records, and subdomain CNAME. Certificate issuance is asynchronous.

> **AWS availability:** AWS says App Runner is no longer open to new customers.
> This example is usable only in AWS accounts with existing App Runner access.
> New customers should choose another container host, such as
> [ECS Express Mode](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).
> This repository does not currently provide that alternative stack.

Configuration is `.env`-driven. Always use `./up.sh`; it exports the file's
values so the program and provider plugins receive the same configuration, and
it selects the required `MCP_STACK` before any Pulumi command runs.

## One-time setup and deploy

```bash
cd deploy/pulumi
npm ci
cp .env.example .env        # fill in every non-commented value
./up.sh                     # creates/selects MCP_STACK, then runs pulumi up
```

Requirements: Pulumi CLI, Docker, credentials for an AWS account with existing
App Runner access, and a Cloudflare token scoped to Zone:Read + DNS:Edit.

Read the resulting URL with:

```bash
./up.sh stack output connectorUrl --show-secrets
```

Do not paste a shared user's InsuranceXDate key into an organization-wide
connector. InsuranceXDate's [MCP guide](https://insurancexdate.helpjuice.com/en_US/integrations/mcp)
describes user-specific credentials, and its
[Terms of Service](https://www.insurancexdate.com/terms-of-service/) restrict
credential sharing. Each user should configure their own authorized key through
a client surface that keeps it user-scoped, use an InsuranceXDate-native/OAuth
flow when available, or obtain explicit vendor approval for a delegated model.
If an MCP client only supports one organization-wide URL, this BYOK deployment
does not turn that URL into per-user identity or credential exchange.

## Security model

Both modes enforce exact Host and Origin allowlists from `MCP_DOMAIN`:
`MCP_ALLOWED_HOSTS=<domain>` and
`MCP_ALLOWED_ORIGINS=https://<domain>`. A present Origin must match exactly;
requests without Origin are accepted only after Host validation succeeds.
`/healthz` is exempt so App Runner can probe its generated service hostname.
A host entry without a port accepts that exact host with any numeric port;
specify `host:port` when a port must be fixed.

**Private mode** stores one operator's vendor key and protects the endpoint with
a secret path token. The token is a bearer capability, not user authentication:
it has no per-user identity, revocation, quota, or attribution. Use this mode for
one operator or a tightly controlled test. Multi-user use requires an external
identity gateway and a vendor-approved credential/delegation model. Rotate a
leaked token by changing `MCP_PATH_TOKEN` and running `./up.sh`; the stack wires
SSM parameter versions into the service so a completed deployment resolves the
new value.

**BYOK mode** (`MCP_BYOK=1`) creates no SSM key parameters. Each individual
caller must supply their own vendor-authorized key through a user-scoped client
configuration. Putting one person's key into a shared connector URL defeats
BYOK and bills that person's account.

Paid tools default disabled in both modes. An operator must explicitly set
`XDATE_DISABLE_PAID=0` (or another documented false value) to expose them.
Then `?paid=1` expresses caller intent for that connection; it cannot override
an operator-level disable. Whether a client asks before each tool call is
client-dependent and must not be treated as a spend control. Use a narrow tool
allowlist and independently monitored vendor/AWS budgets appropriate to the
deployment.

Persistent account actions are independently disabled. Set
`XDATE_ENABLE_WRITES=1` only for a trusted single-user deployment, append
`?writes=1` to the connector URL (combine with `?paid=1&writes=1` when needed),
and pass `confirm=true` on every `add_note` or `set_flag` call. These controls
express operator and caller intent, but they do not provide per-user identity or
prove a human approved the exact mutation. The server never automatically
retries write actions after an ambiguous timeout.

The server also applies an authenticated pre-body ingress limiter, body-read timeout, and
in-flight request cap. Defaults are documented in `.env.example`; operators can
set `MCP_INGRESS_RATE_LIMIT_PER_MIN`, `MCP_BODY_TIMEOUT_MS`, and
`MCP_MAX_INFLIGHT_REQUESTS` to positive integers when the host needs tighter
bounds.

For local Docker testing, set allowlists explicitly for the address clients use:

```bash
docker run --rm -p 8080:8080 \
  -e MCP_ALLOWED_HOSTS=localhost:8080,127.0.0.1:8080 \
  -e MCP_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 \
  -e MCP_BYOK=1 -e XDATE_DISABLE_PAID=1 \
  -e XDATE_ENABLE_WRITES=0 insurancexdate-mcp
```

## Running a second endpoint

Use a separate env file, stack, service name, and domain for each endpoint:

```bash
cp .env.example .env.byok   # MCP_STACK=byok, MCP_BYOK=1,
                            # MCP_SERVICE_NAME=insurancexdate-mcp-byok, ...
./up.sh -e .env.byok
```

`MCP_STACK` is mandatory. The wrapper refuses to run without it so values cannot
silently land in a previously selected stack.

## Cost controls

`MCP_MAX_INSTANCES` defaults to 1. This bounds concurrent App Runner instances
and limits multiplication of per-process rate limits; it is not a monthly cost
cap. `MCP_BILLING_ALERT_EMAIL` optionally creates account-wide AWS Budget alerts
at 80% actual and 100% forecasted spend. AWS Budget alerts notify only: they do
not stop resources or charges. Monitor InsuranceXDate usage separately because
AWS controls cannot cap upstream API charges.

## Traffic visibility

The HTTP server emits structured operational records for accepted authenticated
POST requests and selected rejection/error paths. These are useful diagnostics,
not a complete access or security audit log: health checks, some early
rejections, and caller identity are not fully represented. App Runner forwards
container stdout to CloudWatch Logs. Do not rely on these records for per-user
attribution, especially in private shared-token mode.
