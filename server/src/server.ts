/**
 * Transport-agnostic server assembly, shared by the stdio entrypoint
 * (index.ts) and the remote streamable-HTTP entrypoint (http.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { XdateClient } from "./xdate-client.js";
import {
  buildHandlers,
  SearchSchema,
  BenefitsSearchSchema,
  MatchSchema,
  FilterSchema,
  CompanyDetailsSchema,
  TalkpointsSchema,
  SerffSearchSchema,
  SerffFilingSchema,
  FlaggedCompaniesSchema,
  GroupsSchema,
  GroupCompaniesSchema,
  SavedSearchesSchema,
  RunSavedSearchSchema,
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

/**
 * A key with interior whitespace or control characters would be rejected by
 * undici's header validation per-call — and the thrown message echoes the
 * header value, leaking the key into tool error text. Validate up front and
 * reject WITHOUT echoing the key.
 */
export const API_KEY_CHARSET = /^[!-~]+$/;

/**
 * Reads and validates INSURANCEXDATE_API_KEY, exiting the process with a
 * key-free message on failure.
 */
export function readApiKeyOrExit(): string {
  const apiKey = process.env.INSURANCEXDATE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error("INSURANCEXDATE_API_KEY environment variable is required");
    process.exit(1);
  }
  if (!API_KEY_CHARSET.test(apiKey)) {
    console.error(
      "INSURANCEXDATE_API_KEY contains invalid characters (whitespace or control characters). Re-paste the key as a single line.",
    );
    process.exit(1);
  }
  return apiKey;
}

export function createServer(client: XdateClient): McpServer {
  const handlers = buildHandlers(client);

  const server = new McpServer({
    name: "insurancexdate",
    version: "1.3.5",
  });
  // Surface MCP protocol-level errors on stderr instead of swallowing them.
  server.server.onerror = (err) => console.error("insurancexdate MCP error:", err);

  server.registerTool(
    "search",
    {
      title: "Search prospects",
      description: TOOL_DESCRIPTIONS.search,
      inputSchema: SearchSchema as AnySchema,
      // No outputSchema declared — see tools.ts comment under "Output schemas".
      // Summary: zod's default strip-on-unknown behavior would drop new fields
      // XDate may add at the top level; passthrough at the top can't be expressed
      // as a ZodRawShape. Better to let structuredContent flow through unmodified.
    },
    handlers.search as AnyHandler,
  );

  server.registerTool(
    "match",
    { title: "Find business by name/FEIN/phone/address", description: TOOL_DESCRIPTIONS.match, inputSchema: MatchSchema as AnySchema },
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
    { title: "SERFF filing search (paid $0.05, ledger-confirmed)", description: TOOL_DESCRIPTIONS.serff_search, inputSchema: SerffSearchSchema as AnySchema },
    handlers.serff_search as AnyHandler,
  );

  server.registerTool(
    "serff_filing",
    { title: "SERFF filing details (paid $0.10)", description: TOOL_DESCRIPTIONS.serff_filing, inputSchema: SerffFilingSchema as AnySchema },
    handlers.serff_filing as AnyHandler,
  );

  server.registerTool(
    "benefits_search",
    { title: "Benefits search (Form 5500 retirement/health)", description: TOOL_DESCRIPTIONS.benefits_search, inputSchema: BenefitsSearchSchema as AnySchema },
    handlers.benefits_search as AnyHandler,
  );

  server.registerTool(
    "flagged_companies",
    { title: "List flagged companies", description: TOOL_DESCRIPTIONS.flagged_companies, inputSchema: FlaggedCompaniesSchema as AnySchema },
    handlers.flagged_companies as AnyHandler,
  );

  server.registerTool(
    "groups",
    { title: "List saved company groups", description: TOOL_DESCRIPTIONS.groups, inputSchema: GroupsSchema as AnySchema },
    handlers.groups as AnyHandler,
  );

  server.registerTool(
    "group_companies",
    { title: "Companies in a saved group (gated)", description: TOOL_DESCRIPTIONS.group_companies, inputSchema: GroupCompaniesSchema as AnySchema },
    handlers.group_companies as AnyHandler,
  );

  server.registerTool(
    "saved_searches",
    { title: "List saved searches", description: TOOL_DESCRIPTIONS.saved_searches, inputSchema: SavedSearchesSchema as AnySchema },
    handlers.saved_searches as AnyHandler,
  );

  server.registerTool(
    "run_saved_search",
    { title: "Run a saved search (gated)", description: TOOL_DESCRIPTIONS.run_saved_search, inputSchema: RunSavedSearchSchema as AnySchema },
    handlers.run_saved_search as AnyHandler,
  );

  return server;
}
