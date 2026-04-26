#!/usr/bin/env node
/**
 * InsuranceXDate MCP server - TypeScript on Anthropic's bundled Node runtime.
 *
 * Wraps the XDate REST API at /api2/Search with parameter translation,
 * bridging the schema differences between the upstream MCP at /api2/McpData
 * and the REST endpoint. Other tools pass through to upstream MCP unchanged.
 *
 * Auth: reads INSURANCEXDATE_API_KEY from env (set by .mcpb user_config.api_key
 * with "sensitive": true, stored in OS keychain).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { XdateClient } from "./xdate-client.js";
import {
  buildHandlers,
  SearchSchema,
  SearchOutputSchema,
  MatchSchema,
  FilterSchema,
  CompanyDetailsSchema,
  TalkpointsSchema,
  SerffSearchSchema,
  SerffFilingSchema,
  TOOL_DESCRIPTIONS,
} from "./tools.js";

/**
 * Type-erase the schema and handler at the registerTool call site.
 *
 * Why: SDK 1.29's `registerTool<OutputArgs, InputArgs>` infers InputArgs
 * from the literal shape of `inputSchema`. With 16-field schemas (search),
 * TS's ShapeOutput<InputArgs> mapped type triggers TS2589 (instantiation
 * excessively deep). Erasing to `any` at the call site bypasses the
 * inference; the runtime is unaffected and zod still validates input
 * against the actual schema metadata.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = any;

async function main() {
  const apiKey = process.env.INSURANCEXDATE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error("INSURANCEXDATE_API_KEY environment variable is required");
    process.exit(1);
  }

  const client = new XdateClient(apiKey);
  const handlers = buildHandlers(client);

  const server = new McpServer({
    name: "insurancexdate",
    version: "1.1.3",
  });

  server.registerTool(
    "search",
    {
      title: "Search prospects",
      description: TOOL_DESCRIPTIONS.search,
      inputSchema: SearchSchema as AnySchema,
      outputSchema: SearchOutputSchema as AnySchema,
    },
    handlers.search as AnyHandler,
  );

  server.registerTool(
    "match",
    { title: "Find business by name/FEIN/phone", description: TOOL_DESCRIPTIONS.match, inputSchema: MatchSchema as AnySchema },
    handlers.match as AnyHandler,
  );

  server.registerTool(
    "filter",
    { title: "Look up filter values", description: TOOL_DESCRIPTIONS.filter, inputSchema: FilterSchema as AnySchema },
    handlers.filter as AnyHandler,
  );

  server.registerTool(
    "company_details",
    { title: "Company details (paid $0.25)", description: TOOL_DESCRIPTIONS.company_details, inputSchema: CompanyDetailsSchema as AnySchema },
    handlers.company_details as AnyHandler,
  );

  server.registerTool(
    "talkpoints",
    { title: "Talkpoints (paid $0.10)", description: TOOL_DESCRIPTIONS.talkpoints, inputSchema: TalkpointsSchema as AnySchema },
    handlers.talkpoints as AnyHandler,
  );

  server.registerTool(
    "serff_search",
    { title: "SERFF filing search (paid $0.05)", description: TOOL_DESCRIPTIONS.serff_search, inputSchema: SerffSearchSchema as AnySchema },
    handlers.serff_search as AnyHandler,
  );

  server.registerTool(
    "serff_filing",
    { title: "SERFF filing details (paid $0.10)", description: TOOL_DESCRIPTIONS.serff_filing, inputSchema: SerffFilingSchema as AnySchema },
    handlers.serff_filing as AnyHandler,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
