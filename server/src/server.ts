/**
 * Transport-agnostic server assembly, shared by the stdio entrypoint
 * (index.ts) and the remote streamable-HTTP entrypoint (http.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { XdateClient } from "./xdate-client.js";
import {
  buildHandlers,
  SearchSchema,
  NativeSearchSchema,
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
  AccountStatusSchema,
  AddNoteSchema,
  SetFlagSchema,
  TOOL_DESCRIPTIONS,
  paidDisabled,
  writesEnabled,
} from "./tools.js";

/**
 * Type-erase the schema and handler at the registerTool call site.
 *
 * Why: the SDK's `registerTool<OutputArgs, InputArgs>` infers InputArgs
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

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const METERED_READ_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const ADD_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const DESTRUCTIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

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

/**
 * opts.paidTools: register the six gated tools ($0.05-$0.25/call upstream).
 * opts.writeTools: register add_note and set_flag only when the separate
 * XDATE_ENABLE_WRITES authority is also enabled.
 * Both options can only narrow their corresponding fail-closed environment
 * settings. Disabled tools are absent from tools/list so a model does not
 * consider capabilities that the handler would refuse.
 */
export function createServer(client: XdateClient, opts?: { paidTools?: boolean; writeTools?: boolean }): McpServer {
  const paidTools = (opts?.paidTools ?? true) && !paidDisabled();
  const writeTools = (opts?.writeTools ?? true) && writesEnabled();
  const handlers = buildHandlers(client);

  const server = new McpServer({
    name: "insurancexdate",
    version: "1.5.0",
  });
  // Surface a stable diagnostic without serializing SDK errors: some include
  // the full caller-controlled JSON-RPC message (including query data).
  server.server.onerror = () => console.error('{"evt":"mcp_error","error":"protocol_error"}');

  server.registerTool(
    "search",
    {
      title: "Search prospects",
      description: TOOL_DESCRIPTIONS.search,
      inputSchema: SearchSchema as AnySchema,
      annotations: READ_ANNOTATIONS,
      // No outputSchema declared — see tools.ts comment under "Output schemas".
      // Summary: zod's default strip-on-unknown behavior would drop new fields
      // XDate may add at the top level; passthrough at the top can't be expressed
      // as a ZodRawShape. Better to let structuredContent flow through unmodified.
    },
    handlers.search as AnyHandler,
  );

  server.registerTool(
    "native_search",
    {
      title: "Advanced native XDate search",
      description: TOOL_DESCRIPTIONS.native_search,
      inputSchema: NativeSearchSchema as AnySchema,
      annotations: READ_ANNOTATIONS,
    },
    handlers.native_search as AnyHandler,
  );

  server.registerTool(
    "account_status",
    {
      title: "Check prepaid XChange balance",
      description: TOOL_DESCRIPTIONS.account_status,
      inputSchema: AccountStatusSchema as AnySchema,
      annotations: READ_ANNOTATIONS,
    },
    handlers.account_status as AnyHandler,
  );

  server.registerTool(
    "match",
    { title: "Find business by name/FEIN/phone/address", description: TOOL_DESCRIPTIONS.match, inputSchema: MatchSchema as AnySchema, annotations: READ_ANNOTATIONS },
    handlers.match as AnyHandler,
  );

  server.registerTool(
    "filter",
    { title: "Look up filter values", description: TOOL_DESCRIPTIONS.filter, inputSchema: FilterSchema as AnySchema, annotations: READ_ANNOTATIONS },
    handlers.filter as AnyHandler,
  );

  server.registerTool(
    "benefits_search",
    { title: "Benefits search (Form 5500 retirement/health)", description: TOOL_DESCRIPTIONS.benefits_search, inputSchema: BenefitsSearchSchema as AnySchema, annotations: READ_ANNOTATIONS },
    handlers.benefits_search as AnyHandler,
  );

  server.registerTool(
    "flagged_companies",
    { title: "List flagged companies", description: TOOL_DESCRIPTIONS.flagged_companies, inputSchema: FlaggedCompaniesSchema as AnySchema, annotations: READ_ANNOTATIONS },
    handlers.flagged_companies as AnyHandler,
  );

  server.registerTool(
    "groups",
    { title: "List saved company groups", description: TOOL_DESCRIPTIONS.groups, inputSchema: GroupsSchema as AnySchema, annotations: READ_ANNOTATIONS },
    handlers.groups as AnyHandler,
  );

  server.registerTool(
    "saved_searches",
    { title: "List saved searches", description: TOOL_DESCRIPTIONS.saved_searches, inputSchema: SavedSearchesSchema as AnySchema, annotations: READ_ANNOTATIONS },
    handlers.saved_searches as AnyHandler,
  );

  // Gated tools ($0.05-$0.25/call upstream, or unverified stored-content
  // executors). Registered only when paid tools are in play; in free mode
  // they are invisible rather than present-but-refusing.
  if (paidTools) {
    server.registerTool(
      "company_details",
      { title: "Company details (paid $0.25)", description: TOOL_DESCRIPTIONS.company_details, inputSchema: CompanyDetailsSchema as AnySchema, annotations: METERED_READ_ANNOTATIONS },
      handlers.company_details as AnyHandler,
    );

    server.registerTool(
      "talkpoints",
      { title: "Talkpoints (paid $0.10)", description: TOOL_DESCRIPTIONS.talkpoints, inputSchema: TalkpointsSchema as AnySchema, annotations: METERED_READ_ANNOTATIONS },
      handlers.talkpoints as AnyHandler,
    );

    server.registerTool(
      "serff_search",
      { title: "SERFF filing search (paid $0.05, ledger-confirmed)", description: TOOL_DESCRIPTIONS.serff_search, inputSchema: SerffSearchSchema as AnySchema, annotations: METERED_READ_ANNOTATIONS },
      handlers.serff_search as AnyHandler,
    );

    server.registerTool(
      "serff_filing",
      { title: "SERFF filing details (paid $0.10)", description: TOOL_DESCRIPTIONS.serff_filing, inputSchema: SerffFilingSchema as AnySchema, annotations: METERED_READ_ANNOTATIONS },
      handlers.serff_filing as AnyHandler,
    );

    server.registerTool(
      "group_companies",
      { title: "Companies in a saved group (gated)", description: TOOL_DESCRIPTIONS.group_companies, inputSchema: GroupCompaniesSchema as AnySchema, annotations: READ_ANNOTATIONS },
      handlers.group_companies as AnyHandler,
    );

    server.registerTool(
      "run_saved_search",
      { title: "Run a saved search (gated)", description: TOOL_DESCRIPTIONS.run_saved_search, inputSchema: RunSavedSearchSchema as AnySchema, annotations: READ_ANNOTATIONS },
      handlers.run_saved_search as AnyHandler,
    );
  }

  // Persistent account mutations are independent of paid-read visibility.
  // They require explicit server authority; the handlers re-check the env gate
  // and strip the wrapper-only confirm field before forwarding upstream.
  if (writeTools) {
    server.registerTool(
      "add_note",
      {
        title: "Add agency-shared company note",
        description: TOOL_DESCRIPTIONS.add_note,
        inputSchema: AddNoteSchema as AnySchema,
        annotations: ADD_WRITE_ANNOTATIONS,
      },
      handlers.add_note as AnyHandler,
    );

    server.registerTool(
      "set_flag",
      {
        title: "Set or remove company flag",
        description: TOOL_DESCRIPTIONS.set_flag,
        inputSchema: SetFlagSchema as AnySchema,
        annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
      },
      handlers.set_flag as AnyHandler,
    );
  }

  return server;
}
