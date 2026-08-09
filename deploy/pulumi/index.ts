/**
 * Deploys the remote streamable-HTTP entrypoint (server/src/http.ts) to AWS
 * App Runner: builds server/Dockerfile into ECR, stores the two secrets in
 * SSM, and exposes an HTTPS URL suitable for a claude.ai organization
 * custom connector.
 *
 * Stack config:
 *   pulumi config set --secret apiKey     <InsuranceXDate API key>
 *   pulumi config set --secret pathToken  "$(openssl rand -hex 24)"
 *   pulumi config set domain mcp.example.com
 *   pulumi config set disablePaid false   # optional; paid tools are disabled by default
 *
 * The connector URL (including the secret path token) is exported as the
 * `connectorUrl` stack output; read it with `pulumi stack output connectorUrl --show-secrets`.
 */

import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const apiKey = config.requireSecret("apiKey");
const pathToken = config.requireSecret("pathToken");
// Default ON for a shared instance: paid tools bill the single org-wide key.
const disablePaid = config.getBoolean("disablePaid") ?? true;
// Custom domain in front of the generated App Runner hostname (e.g.
// mcp.example.com), so the connector URL survives service re-creation. The
// zone apex is derived from the last two labels; override with `zoneName`
// for multi-label zones.
const domain = config.require("domain");
const zoneName = config.get("zoneName") ?? domain.split(".").slice(-2).join(".");

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
