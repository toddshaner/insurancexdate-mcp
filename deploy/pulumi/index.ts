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
 * same values. Required: INSURANCEXDATE_API_KEY, MCP_PATH_TOKEN, MCP_DOMAIN,
 * CLOUDFLARE_API_TOKEN. See .env.example for the full list.
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

// pulumi.secret() so the values are encrypted in the stack state, not just
// absent from source control.
const apiKey = pulumi.secret(requireEnv("INSURANCEXDATE_API_KEY"));
const rawPathToken = requireEnv("MCP_PATH_TOKEN");
if (rawPathToken.length < MIN_TOKEN_LENGTH) {
  throw new Error(
    `MCP_PATH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (generate one with \`openssl rand -hex 24\`).`,
  );
}
const pathToken = pulumi.secret(rawPathToken);

// Custom domain in front of the generated App Runner hostname (e.g.
// mcp.example.com), so the connector URL survives service re-creation. The
// zone apex is derived from the last two labels; override with MCP_ZONE_NAME
// for multi-label zones.
const domain = requireEnv("MCP_DOMAIN");
const zoneName = process.env.MCP_ZONE_NAME?.trim() || domain.split(".").slice(-2).join(".");

// Paid tools ($0.05-$0.25/call) stay DISABLED unless explicitly re-enabled:
// a shared instance spends one account's balance for every caller. Uses the
// falsy mirror of the server's TRUTHY_DISABLE_VALUES (tools.ts) so
// XDATE_DISABLE_PAID=0/false/no/off/disabled opts back in.
const PAID_OPT_IN_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const disablePaid = !PAID_OPT_IN_VALUES.has(
  (process.env.XDATE_DISABLE_PAID ?? "").trim().toLowerCase(),
);

const repo = new awsx.ecr.Repository("insurancexdate-mcp", {
  forceDelete: true,
});

const image = new awsx.ecr.Image("insurancexdate-mcp", {
  repositoryUrl: repo.url,
  context: "../../server",
  platform: "linux/amd64",
});

const apiKeyParam = new aws.ssm.Parameter("api-key", {
  name: "/insurancexdate-mcp/api-key",
  type: "SecureString",
  value: apiKey,
});

const pathTokenParam = new aws.ssm.Parameter("path-token", {
  name: "/insurancexdate-mcp/path-token",
  type: "SecureString",
  value: pathToken,
});

// App Runner pulls the image from ECR with this role.
const accessRole = new aws.iam.Role("ecr-access", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "build.apprunner.amazonaws.com",
  }),
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
  ],
});

// The running container resolves runtimeEnvironmentSecrets with this role.
const instanceRole = new aws.iam.Role("instance", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "tasks.apprunner.amazonaws.com",
  }),
});

new aws.iam.RolePolicy("instance-ssm-read", {
  role: instanceRole.id,
  policy: pulumi
    .all([apiKeyParam.arn, pathTokenParam.arn])
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

const service = new aws.apprunner.Service("insurancexdate-mcp", {
  serviceName: "insurancexdate-mcp",
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
        runtimeEnvironmentVariables: disablePaid ? { XDATE_DISABLE_PAID: "1" } : {},
        runtimeEnvironmentSecrets: {
          INSURANCEXDATE_API_KEY: apiKeyParam.arn,
          MCP_PATH_TOKEN: pathTokenParam.arn,
        },
      },
    },
  },
  instanceConfiguration: {
    cpu: "256",
    memory: "512",
    instanceRoleArn: instanceRole.arn,
  },
  healthCheckConfiguration: {
    protocol: "HTTP",
    path: "/healthz",
  },
});

// The Cloudflare provider authenticates via the CLOUDFLARE_API_TOKEN env var
// (a token scoped to Zone:Read + DNS:Edit on this zone).
const zoneId = cloudflare.getZoneOutput({ filter: { name: zoneName } }).apply((z) => z.id);

const domainAssociation = new aws.apprunner.CustomDomainAssociation("domain", {
  domainName: domain,
  serviceArn: service.arn,
  enableWwwSubdomain: false,
});

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
// Contains the path token — a capability URL. Paste into claude.ai
// Organization settings -> Connectors, and treat it like a credential.
export const connectorUrl = pulumi.secret(pulumi.interpolate`https://${domain}/mcp/${pathToken}`);
