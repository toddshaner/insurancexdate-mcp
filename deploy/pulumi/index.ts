/**
 * Deploys the remote streamable-HTTP entrypoint (server/src/http.ts) to AWS
 * App Runner: builds server/Dockerfile into ECR, stores the two secrets in
 * SSM, fronts the service with a custom domain in Cloudflare DNS, and
 * exposes an HTTPS URL suitable for a claude.ai organization custom
 * connector.
 *
 * Configuration is entirely environment-driven — copy .env.example to .env
 * and deploy with ./up.sh, which sources .env into the process environment
 * so both this program and the provider plugins (AWS, Cloudflare) see the
 * same values. Always required: MCP_DOMAIN, CLOUDFLARE_API_TOKEN. Private
 * mode additionally requires INSURANCEXDATE_API_KEY + MCP_PATH_TOKEN; BYOK
 * mode (MCP_BYOK=1) forbids them. See .env.example for the full list.
 *
 * The connector URL (including the secret path token) is exported as the
 * `connectorUrl` stack output; read it with
 * `./up.sh stack output connectorUrl --show-secrets`.
 */

import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env, fill it in, and deploy via ./up.sh so the values reach the provider plugins too.`,
    );
  }
  return value;
}

// Mirrors MIN_TOKEN_LENGTH in server/src/http.ts — fail at deploy time, not
// at container startup.
const MIN_TOKEN_LENGTH = 16;

// MCP_BYOK=1 deploys a bring-your-own-key server: no key of its own, callers
// send theirs per request (see server/src/http.ts). Mirrors the server's
// truthy set. Mutually exclusive with the private-mode secrets below.
const BYOK_TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const byokMode = BYOK_TRUTHY.has((process.env.MCP_BYOK ?? "").trim().toLowerCase());
if (byokMode && (process.env.INSURANCEXDATE_API_KEY || process.env.MCP_PATH_TOKEN)) {
  throw new Error(
    "MCP_BYOK=1 is incompatible with INSURANCEXDATE_API_KEY / MCP_PATH_TOKEN in .env — a BYOK server must hold no key of its own.",
  );
}

// pulumi.secret() so the values are encrypted in the stack state, not just
// absent from source control.
const apiKey = byokMode ? null : pulumi.secret(requireEnv("INSURANCEXDATE_API_KEY"));
const rawPathToken = byokMode ? null : requireEnv("MCP_PATH_TOKEN");
if (rawPathToken !== null && rawPathToken.length < MIN_TOKEN_LENGTH) {
  throw new Error(
    `MCP_PATH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (generate one with \`openssl rand -hex 24\`).`,
  );
}
const pathToken = rawPathToken === null ? null : pulumi.secret(rawPathToken);

// Custom domain in front of the generated App Runner hostname (e.g.
// mcp.example.com), so the connector URL survives service re-creation. The
// zone apex is derived from the last two labels; override with MCP_ZONE_NAME
// for multi-label zones.
const domain = requireEnv("MCP_DOMAIN");
const zoneName = process.env.MCP_ZONE_NAME?.trim() || domain.split(".").slice(-2).join(".");

// Physical service name; must be unique per stack when several endpoints
// (e.g. a private instance and a BYOK instance) share one AWS account. The
// default matches the original single-stack deployment so existing stacks
// don't churn. SSM parameter paths derive from it for the same reason.
const serviceName = process.env.MCP_SERVICE_NAME?.trim() || "insurancexdate-mcp";

// Paid tools ($0.05-$0.25/call): the mode decides the default, matching how
// metered-API MCP servers normally work. Private mode disables them unless
// opted in — every call spends the HOST's key. BYOK enables them — callers
// spend their own accounts, tools are price-labeled, and the client's
// per-tool permission prompt is the spend gate. XDATE_DISABLE_PAID set
// explicitly overrides either way (truthy disables, falsy enables).
const PAID_OPT_IN_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const rawDisablePaid = (process.env.XDATE_DISABLE_PAID ?? "").trim().toLowerCase();
const disablePaid = rawDisablePaid === "" ? !byokMode : !PAID_OPT_IN_VALUES.has(rawDisablePaid);

const repo = new awsx.ecr.Repository("insurancexdate-mcp", {
  forceDelete: true,
});

const image = new awsx.ecr.Image("insurancexdate-mcp", {
  repositoryUrl: repo.url,
  context: "../../server",
  platform: "linux/amd64",
});

// Private mode only: the two secrets live in SSM and reach the container as
// runtimeEnvironmentSecrets. A BYOK deployment has nothing to store.
const secretParams = byokMode
  ? null
  : {
      apiKey: new aws.ssm.Parameter("api-key", {
        name: `/${serviceName}/api-key`,
        type: "SecureString",
        value: apiKey as pulumi.Output<string>,
      }),
      pathToken: new aws.ssm.Parameter("path-token", {
        name: `/${serviceName}/path-token`,
        type: "SecureString",
        value: pathToken as pulumi.Output<string>,
      }),
    };

// App Runner pulls the image from ECR with this role.
const accessRole = new aws.iam.Role("ecr-access", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "build.apprunner.amazonaws.com",
  }),
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
  ],
});

// Private mode only: the container resolves runtimeEnvironmentSecrets with
// this role. A BYOK instance reads no secrets, so it gets no instance role
// at all.
const instanceRole = secretParams
  ? new aws.iam.Role("instance", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "tasks.apprunner.amazonaws.com",
      }),
    })
  : null;

if (secretParams && instanceRole) {
  new aws.iam.RolePolicy("instance-ssm-read", {
    role: instanceRole.id,
    policy: pulumi
      .all([secretParams.apiKey.arn, secretParams.pathToken.arn])
      .apply(([apiKeyArn, pathTokenArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ssm:GetParameters"],
              Resource: [apiKeyArn, pathTokenArn],
            },
          ],
        }),
      ),
  });
}

const service = new aws.apprunner.Service("insurancexdate-mcp", {
  serviceName,
  sourceConfiguration: {
    autoDeploymentsEnabled: false,
    authenticationConfiguration: { accessRoleArn: accessRole.arn },
    imageRepository: {
      imageIdentifier: image.imageUri,
      imageRepositoryType: "ECR",
      imageConfiguration: {
        port: "8080",
        // Omit XDATE_DISABLE_PAID entirely when paid tools are wanted:
        // tools.ts warns on any set-but-unrecognized value.
        runtimeEnvironmentVariables: {
          ...(disablePaid ? { XDATE_DISABLE_PAID: "1" } : {}),
          ...(byokMode ? { MCP_BYOK: "1" } : {}),
          ...(process.env.MCP_RATE_LIMIT_PER_MIN?.trim()
            ? { MCP_RATE_LIMIT_PER_MIN: process.env.MCP_RATE_LIMIT_PER_MIN.trim() }
            : {}),
        },
        runtimeEnvironmentSecrets: secretParams
          ? {
              INSURANCEXDATE_API_KEY: secretParams.apiKey.arn,
              MCP_PATH_TOKEN: secretParams.pathToken.arn,
            }
          : {},
      },
    },
  },
  instanceConfiguration: {
    cpu: "256",
    memory: "512",
    ...(instanceRole ? { instanceRoleArn: instanceRole.arn } : {}),
  },
  healthCheckConfiguration: {
    protocol: "HTTP",
    path: "/healthz",
  },
});

// The Cloudflare provider authenticates via the CLOUDFLARE_API_TOKEN env var
// (a token scoped to Zone:Read + DNS:Edit on this zone).
const zoneId = cloudflare.getZoneOutput({ filter: { name: zoneName } }).apply((z) => z.id);

const domainAssociation = new aws.apprunner.CustomDomainAssociation(
  "domain",
  {
    domainName: domain,
    serviceArn: service.arn,
    enableWwwSubdomain: false,
  },
  // A domain can only be associated with one service at a time, so the
  // default create-before-delete replacement order 400s on any service
  // replacement. Brief domain downtime during a swap is the price.
  { deleteBeforeReplace: true },
);

// ACM validation CNAMEs. Must stay unproxied (grey-cloud) or App Runner's
// certificate issuance never validates. Record count is only known after the
// association exists, hence the resource-in-apply shape (they won't show in
// `pulumi preview` on first run).
domainAssociation.certificateValidationRecords.apply((records) =>
  records.map(
    (record, i) =>
      new cloudflare.DnsRecord(`cert-validation-${i}`, {
        zoneId,
        name: record.name.replace(/\.$/, ""),
        type: record.type,
        content: record.value.replace(/\.$/, ""),
        ttl: 300,
        proxied: false,
      }),
  ),
);

// Unproxied to start: App Runner terminates TLS with its managed cert.
// Flipping to proxied later (Cloudflare WAF/analytics in front) is possible
// but changes the TLS-origin story — do it deliberately, not by default.
new cloudflare.DnsRecord("mcp-cname", {
  zoneId,
  name: domain,
  type: "CNAME",
  content: domainAssociation.dnsTarget,
  ttl: 300,
  proxied: false,
});

export const serviceUrl = pulumi.interpolate`https://${service.serviceUrl}`;
// Private mode: contains the path token — a capability URL. Paste into
// claude.ai Organization settings -> Connectors and treat it like a
// credential. BYOK mode: a template — each caller substitutes their own
// InsuranceXDate API key (or sends it as a Bearer header to /mcp instead).
export const connectorUrl = pathToken
  ? pulumi.secret(pulumi.interpolate`https://${domain}/mcp/${pathToken}`)
  : pulumi.output(`https://${domain}/mcp/<your-insurancexdate-api-key>`);
