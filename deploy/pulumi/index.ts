/**
 * Deploys the remote streamable-HTTP entrypoint (server/src/http.ts) to AWS
 * App Runner: builds server/Dockerfile into ECR, stores the two secrets in
 * SSM, fronts the service with a custom domain in Cloudflare DNS, and
 * exposes an HTTPS URL suitable for a compatible remote MCP client.
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

// Paid tools ($0.05-$0.25/call) default off in both HTTP modes. Client-side
// prompts vary and cannot be the operator's spend control. The operator must
// explicitly set XDATE_DISABLE_PAID to a recognized false value to expose
// paid tools; a request's ?paid=1 remains caller intent and cannot override
// this deployment-level disable.
const PAID_ENABLE_VALUES = new Set(["0", "false", "no", "off"]);
export function paidToolsDisabled(rawValue: string | undefined): boolean {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  return normalized === "" || !PAID_ENABLE_VALUES.has(normalized);
}
const disablePaid = paidToolsDisabled(process.env.XDATE_DISABLE_PAID);

// Cost guardrails. App Runner's DEFAULT auto-scaling config runs up to 25
// instances, so a sustained request flood (the endpoint is directly
// reachable — the Cloudflare record is deliberately unproxied) scales the
// bill ~25x. One small instance serves this workload and bounds concurrent
// instance count, but it does not cap monthly spend. Raise MCP_MAX_INSTANCES
// only with intent. Note the server's rate limiter is per-process, so
// instance count also multiplies the effective rate limits.
const rawMaxInstances = process.env.MCP_MAX_INSTANCES?.trim() || "1";
const maxInstances = Number(rawMaxInstances);
if (!Number.isInteger(maxInstances) || maxInstances < 1) {
  throw new Error(`MCP_MAX_INSTANCES must be a positive integer; got ${JSON.stringify(rawMaxInstances)}.`);
}

// Optional monthly cost budget with email alerts (ACCOUNT-wide spend, not
// just this service — AWS cost data can't be scoped to one App Runner
// service reliably). Created only when an alert address is configured.
const billingAlertEmail = process.env.MCP_BILLING_ALERT_EMAIL?.trim() || null;
const rawBudgetUsd = process.env.MCP_MONTHLY_BUDGET_USD?.trim() || "50";
if (billingAlertEmail && !(Number(rawBudgetUsd) > 0)) {
  throw new Error(`MCP_MONTHLY_BUDGET_USD must be a positive number; got ${JSON.stringify(rawBudgetUsd)}.`);
}

const repo = new awsx.ecr.Repository("insurancexdate-mcp", {
  forceDelete: true,
  imageScanningConfiguration: { scanOnPush: true },
  imageTagMutability: "IMMUTABLE",
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

const instanceSsmPolicy =
  secretParams && instanceRole
    ? new aws.iam.RolePolicy("instance-ssm-read", {
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
      })
    : null;

export function appRunnerServiceOptions(
  policy: pulumi.Resource | null,
): pulumi.CustomResourceOptions {
  return { dependsOn: policy ? [policy] : [] };
}

const scalingConfig = new aws.apprunner.AutoScalingConfigurationVersion("scaling", {
  autoScalingConfigurationName: serviceName.slice(0, 32),
  minSize: 1,
  maxSize: maxInstances,
});

const service = new aws.apprunner.Service(
  "insurancexdate-mcp",
  {
    serviceName,
    autoScalingConfigurationArn: scalingConfig.arn,
    sourceConfiguration: {
    autoDeploymentsEnabled: false,
    authenticationConfiguration: { accessRoleArn: accessRole.arn },
    imageRepository: {
      imageIdentifier: image.imageUri,
      imageRepositoryType: "ECR",
      imageConfiguration: {
        port: "8080",
        // Emit an explicit value in both states because the server defaults
        // paid tools off unless it receives a recognized false value.
        runtimeEnvironmentVariables: {
          MCP_ALLOWED_HOSTS: domain.toLowerCase(),
          MCP_ALLOWED_ORIGINS: `https://${domain.toLowerCase()}`,
          XDATE_DISABLE_PAID: disablePaid ? "1" : "0",
          ...(byokMode ? { MCP_BYOK: "1" } : {}),
          ...(process.env.MCP_RATE_LIMIT_PER_MIN?.trim()
            ? { MCP_RATE_LIMIT_PER_MIN: process.env.MCP_RATE_LIMIT_PER_MIN.trim() }
            : {}),
          ...(process.env.MCP_GLOBAL_RATE_LIMIT_PER_MIN?.trim()
            ? { MCP_GLOBAL_RATE_LIMIT_PER_MIN: process.env.MCP_GLOBAL_RATE_LIMIT_PER_MIN.trim() }
            : {}),
          ...(process.env.MCP_INGRESS_RATE_LIMIT_PER_MIN?.trim()
            ? { MCP_INGRESS_RATE_LIMIT_PER_MIN: process.env.MCP_INGRESS_RATE_LIMIT_PER_MIN.trim() }
            : {}),
          ...(process.env.MCP_BODY_TIMEOUT_MS?.trim()
            ? { MCP_BODY_TIMEOUT_MS: process.env.MCP_BODY_TIMEOUT_MS.trim() }
            : {}),
          ...(process.env.MCP_MAX_INFLIGHT_REQUESTS?.trim()
            ? { MCP_MAX_INFLIGHT_REQUESTS: process.env.MCP_MAX_INFLIGHT_REQUESTS.trim() }
            : {}),
          // App Runner resolves runtimeEnvironmentSecrets when it deploys a
          // revision, not on each read: rotating the SSM value alone leaves
          // the OLD secret live until something else forces a deployment.
          // Surfacing the parameter versions here makes every rotation a
          // service diff, so `pulumi up` rolls a revision that re-resolves
          // them. The container ignores this variable.
          ...(secretParams
            ? {
                MCP_SECRETS_VERSION: pulumi.interpolate`${secretParams.apiKey.version}-${secretParams.pathToken.version}`,
              }
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
  },
  appRunnerServiceOptions(instanceSsmPolicy),
);

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

// Bill-shock alerts: email at 80% actual and 100% forecasted of the monthly
// budget. This is notification only; AWS Budgets does not stop resources or
// cap spend. Account-wide by design. Requires no console setup; Budgets is
// free for the first two budgets per account.
if (billingAlertEmail) {
  new aws.budgets.Budget("monthly-cost", {
    budgetType: "COST",
    timeUnit: "MONTHLY",
    limitAmount: rawBudgetUsd,
    limitUnit: "USD",
    notifications: [
      {
        comparisonOperator: "GREATER_THAN",
        threshold: 80,
        thresholdType: "PERCENTAGE",
        notificationType: "ACTUAL",
        subscriberEmailAddresses: [billingAlertEmail],
      },
      {
        comparisonOperator: "GREATER_THAN",
        threshold: 100,
        thresholdType: "PERCENTAGE",
        notificationType: "FORECASTED",
        subscriberEmailAddresses: [billingAlertEmail],
      },
    ],
  });
}

export const serviceUrl = pulumi.interpolate`https://${service.serviceUrl}`;
// Private mode: contains the path token — a capability URL intended for one
// operator or a tightly controlled test. It is not per-user authentication.
// BYOK mode: a template for individual user configuration; each caller uses
// their own vendor-authorized key (or Bearer header to /mcp).
export const connectorUrl = pathToken
  ? pulumi.secret(pulumi.interpolate`https://${domain}/mcp/${pathToken}`)
  : pulumi.output(`https://${domain}/mcp/<your-insurancexdate-api-key>`);
