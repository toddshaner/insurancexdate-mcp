/**
 * Deploy-time regression test for secret rotation, run entirely against
 * Pulumi's mock runtime — no cloud credentials, no docker, no network.
 *
 * The bug it pins: App Runner resolves runtimeEnvironmentSecrets when it
 * deploys a revision, not on each read. The service config referenced only
 * the SSM parameter ARNs, which never change when the VALUE is rotated — so
 * `pulumi up` after a rotation produced no service diff and the old path
 * token / API key stayed live until some unrelated redeploy.
 *
 * The fix wires the parameter VERSIONS into the service's environment
 * (MCP_SECRETS_VERSION), so any rotation is a service diff. This test
 * asserts that wiring end to end through the real program (index.ts).
 *
 * Run from deploy/pulumi/: npm test
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";

import * as pulumi from "@pulumi/pulumi";

// Private-mode env the program requires; set before importing index.ts.
process.env.MCP_DOMAIN = "mcp.example.com";
process.env.INSURANCEXDATE_API_KEY = "test-key-123";
process.env.MCP_PATH_TOKEN = "0123456789abcdef0123";
delete process.env.MCP_BYOK;
delete process.env.MCP_RATE_LIMIT_PER_MIN;
delete process.env.MCP_GLOBAL_RATE_LIMIT_PER_MIN;
delete process.env.MCP_INGRESS_RATE_LIMIT_PER_MIN;
delete process.env.MCP_BODY_TIMEOUT_MS;
delete process.env.MCP_MAX_INFLIGHT_REQUESTS;
delete process.env.XDATE_DISABLE_PAID;
delete process.env.MCP_SERVICE_NAME;
delete process.env.MCP_ZONE_NAME;
delete process.env.MCP_MAX_INSTANCES;
delete process.env.MCP_BILLING_ALERT_EMAIL;
delete process.env.MCP_MONTHLY_BUDGET_USD;

// The version the mock SSM parameters report; the marker must reflect it.
const SSM_VERSION = 7;

// Captured by the newResource mock when index.ts registers the resources.
let serviceInputs: Record<string, any> | undefined;
let scalingInputs: Record<string, any> | undefined;

pulumi.runtime.setMocks({
  newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: any } {
    switch (args.type) {
      case "aws:ssm/parameter:Parameter":
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            arn: `arn:aws:ssm:us-east-1:111111111111:parameter${args.inputs.name}`,
            version: SSM_VERSION,
          },
        };
      case "aws:ecr/repository:Repository":
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            repositoryUrl: "111111111111.dkr.ecr.us-east-1.amazonaws.com/insurancexdate-mcp",
            registryId: "111111111111",
          },
        };
      case "aws:apprunner/autoScalingConfigurationVersion:AutoScalingConfigurationVersion":
        scalingInputs = args.inputs;
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            arn: "arn:aws:apprunner:us-east-1:111111111111:autoscalingconfiguration/test/1/abc",
          },
        };
      case "aws:apprunner/service:Service":
        serviceInputs = args.inputs;
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            arn: "arn:aws:apprunner:us-east-1:111111111111:service/test/abc",
            serviceUrl: "abc123.us-east-1.awsapprunner.com",
            status: "RUNNING",
          },
        };
      case "aws:apprunner/customDomainAssociation:CustomDomainAssociation":
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            dnsTarget: "abc123.us-east-1.awsapprunner.com",
            certificateValidationRecords: [],
          },
        };
      default:
        return { id: `${args.name}-id`, state: args.inputs };
    }
  },
  call(args: pulumi.runtime.MockCallArgs): any {
    switch (args.token) {
      case "cloudflare:index/getZone:getZone":
        return { id: "zone-123" };
      case "aws:ecr/getAuthorizationToken:getAuthorizationToken":
        return {
          authorizationToken: Buffer.from("AWS:mock-password").toString("base64"),
          userName: "AWS",
          password: "mock-password",
          proxyEndpoint: "https://111111111111.dkr.ecr.us-east-1.amazonaws.com",
        };
      default:
        return args.inputs;
    }
  },
});

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

test("rotating an SSM secret produces an App Runner service diff", async () => {
  const infra = await import("../index");
  // Awaiting an exported output guarantees the service resource registered.
  await promiseOf(infra.serviceUrl);
  assert.ok(serviceInputs, "App Runner service was never registered");

  const imageConfig = serviceInputs!.sourceConfiguration.imageRepository.imageConfiguration;

  // The rotation marker: derived from both parameters' versions, so a new
  // version of either secret changes the service's desired state.
  assert.equal(
    imageConfig.runtimeEnvironmentVariables.MCP_SECRETS_VERSION,
    `${SSM_VERSION}-${SSM_VERSION}`,
    "MCP_SECRETS_VERSION must be wired to the SSM parameter versions",
  );

  // The secrets themselves still reach the container via the parameter ARNs.
  assert.match(imageConfig.runtimeEnvironmentSecrets.INSURANCEXDATE_API_KEY, /^arn:aws:ssm:/);
  assert.match(imageConfig.runtimeEnvironmentSecrets.MCP_PATH_TOKEN, /^arn:aws:ssm:/);
  assert.equal(
    imageConfig.runtimeEnvironmentVariables.XDATE_DISABLE_PAID,
    "1",
    "HTTP deployments must default paid tools off",
  );
  assert.equal(imageConfig.runtimeEnvironmentVariables.MCP_ALLOWED_HOSTS, "mcp.example.com");
  assert.equal(imageConfig.runtimeEnvironmentVariables.MCP_ALLOWED_ORIGINS, "https://mcp.example.com");
});

test("App Runner waits for the SSM read policy attachment", async () => {
  const infra = await import("../index");
  const markerPolicy = {} as pulumi.Resource;
  assert.deepEqual(infra.appRunnerServiceOptions(markerPolicy).dependsOn, [markerPolicy]);
  assert.deepEqual(infra.appRunnerServiceOptions(null).dependsOn, []);
});

test("paid tools require explicit operator opt-in in both HTTP modes", async () => {
  const infra = await import("../index");
  for (const mode of ["private", "BYOK"]) {
    assert.equal(infra.paidToolsDisabled(undefined), true, `${mode} mode must default paid tools off`);
    assert.equal(infra.paidToolsDisabled(""), true, `${mode} mode must treat blank as disabled`);
  }
  assert.equal(infra.paidToolsDisabled("0"), false, "0 is the explicit operator opt-in");
  assert.equal(infra.paidToolsDisabled("false"), false, "false is the explicit operator opt-in");
  assert.equal(infra.paidToolsDisabled("1"), true);
});

test("auto-scaling is pinned to one instance by default (concurrency bound)", async () => {
  const infra = await import("../index");
  await promiseOf(infra.serviceUrl);
  assert.ok(scalingInputs, "auto-scaling configuration was never registered");
  assert.equal(scalingInputs!.maxSize, 1, "default MCP_MAX_INSTANCES must be 1");
  assert.equal(scalingInputs!.minSize, 1);
  // The service must actually reference it — App Runner's default config
  // (max 25 instances) applies whenever this ARN is absent.
  assert.match(
    serviceInputs!.autoScalingConfigurationArn,
    /^arn:aws:apprunner:.*autoscalingconfiguration/,
    "service must use the pinned auto-scaling configuration",
  );
});
