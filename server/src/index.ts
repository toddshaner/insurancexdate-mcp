#!/usr/bin/env node
/**
 * InsuranceXDate MCP server, stdio entrypoint - TypeScript on Node 20+ (or
 * Anthropic's bundled runtime when shipped as a .mcpb to Claude Desktop).
 * Client-agnostic at the protocol level: any MCP client speaking stdio
 * JSON-RPC can launch it. For the remote streamable-HTTP entrypoint, see
 * http.ts.
 *
 * Wraps the XDate REST API at /api2/Search with parameter translation,
 * bridging the schema differences between the upstream MCP at /api2/McpData
 * and the REST endpoint. Other tools pass through to upstream MCP unchanged.
 *
 * Auth: reads INSURANCEXDATE_API_KEY from env (set by .mcpb user_config.api_key
 * with "sensitive": true, stored in OS keychain).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer, readApiKeyOrExit } from "./server.js";
import { warnIfDisablePaidUnrecognized, warnIfEnableWritesUnrecognized } from "./tools.js";
import { XdateClient } from "./xdate-client.js";

async function main() {
  const apiKey = readApiKeyOrExit();
  warnIfDisablePaidUnrecognized();
  warnIfEnableWritesUnrecognized();

  const server = createServer(new XdateClient(apiKey));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
