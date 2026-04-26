/**
 * InsuranceXDate HTTP clients.
 *
 * Two endpoints:
 *   - /api2/Search   (REST)  - used for `search`, with translated param names
 *   - /api2/McpData  (MCP)   - used as passthrough for tools that work upstream
 *
 * Why two: the upstream MCP at /api2/McpData advertises premfrom/premto/modfrom/modto/limit
 * on its `search` tool, but those values are not applied at runtime. The REST endpoint at
 * /api2/Search accepts equivalent params under different names (fromprem/toprem/frommod/
 * tomod/pagelimit) and applies them as documented in the OpenAPI spec. This client
 * translates between the two naming conventions for `search` only.
 *
 * Verified empirically 2026-04-25:
 *   MCP search with premfrom=10000000 returned pagination.total=33,353 (filter not applied).
 *   REST search with fromprem=10000000 returned 1 record (filter applied as documented).
 *
 * Both public methods always return a valid CallToolResult. Errors are converted to
 * isError-flagged content so the SDK never sees a malformed shape.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://www.insurancexdate.com/api2";
const REST_SEARCH = `${API_BASE}/Search`;
const REST_MATCH = `${API_BASE}/Match`;
const MCP_FALLBACK = `${API_BASE}/McpData`;

/** REST `pagelimit` hard cap. Values above silently fall back to 10. */
const REST_PAGELIMIT_CAP = 50;

/** Per-fetch timeout. XDate can be slow; this prevents hangs from looking like client disconnects. */
const REQUEST_TIMEOUT_MS = 30_000;

/** MCP-style -> REST-style param name translation for /Search. */
const SEARCH_PARAM_TRANSLATIONS: Record<string, string> = {
  premfrom: "fromprem",
  premto: "toprem",
  modfrom: "frommod",
  modto: "tomod",
  limit: "pagelimit",
  offset: "pageon",
};

/**
 * Param fields that may arrive percent-encoded from the REST `/Search` response
 * but must be raw (decoded `+` and `/` characters) for the upstream MCP at
 * `/api2/McpData` to accept them. UIDs are the canonical case. Verified
 * empirically 2026-04-25:
 *   - REST /Search returned UID with `%2B`/`%2F`; passing that to MCP company_details
 *     returned HTTP 419 (Laravel "Page Expired").
 *   - Decoding the same UID to raw `+`/`/` succeeded.
 * Decode is idempotent: a UID without `%` passes through unchanged. Throws-safe
 * via try/catch, so malformed encodings fall back to the original string and
 * surface as a clean upstream error rather than crashing the proxy.
 *
 * Note (v1.1.2): filing_id was previously in this set defensively, but is now
 * typed as integer in SerffFilingSchema (matching upstream's actual schema).
 * The typeof === "string" guard below makes the field listing harmless for
 * integers, but we drop filing_id from the set for clarity.
 */
const PCT_ENCODED_FIELDS = new Set(["uid"]);

function decodePctEncodedFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (PCT_ENCODED_FIELDS.has(k) && typeof v === "string" && v.includes("%")) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function asMcpText(text: string, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text }],
  };
  if (isError) result.isError = true;
  return result;
}

function isCallToolResult(x: unknown): x is CallToolResult {
  return (
    !!x &&
    typeof x === "object" &&
    "content" in x &&
    Array.isArray((x as { content: unknown }).content)
  );
}

export class XdateClient {
  constructor(private apiKey: string) {
    if (!apiKey) {
      throw new Error("INSURANCEXDATE_API_KEY is required");
    }
  }

  /**
   * Call /api2/Search (REST) with translated param names. Used for the `search` tool.
   * Returns both `content` (text fallback for clients that don't read structured)
   * and `structuredContent` (typed JSON) so an LLM client can reason over records reliably.
   */
  async search(args: Record<string, unknown>): Promise<CallToolResult> {
    const restArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const restKey = SEARCH_PARAM_TRANSLATIONS[key] ?? key;
      restArgs[restKey] = value;
    }
    if (typeof restArgs.pagelimit === "number" && restArgs.pagelimit > REST_PAGELIMIT_CAP) {
      restArgs.pagelimit = REST_PAGELIMIT_CAP;
    }
    try {
      const payload = await this.postJson(REST_SEARCH, restArgs);
      const result: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
      // Only set structuredContent if payload is a plain object (XDate REST shape).
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        result.structuredContent = payload as { [key: string]: unknown };
      }
      return result;
    } catch (err) {
      return asMcpText(`XDate REST search error: ${errorMessage(err)}`, true);
    }
  }

  /**
   * Call /api2/Match (REST). Find a business by name + state / FEIN / phone.
   * The proper find-by-name endpoint (search's `name` param doesn't actually filter at REST).
   * Returns CallToolResult wrapping the parsed JSON response. Note that this endpoint
   * may return HTTP 4xx (unauthorized) for API keys without /Match access in their
   * subscription tier — surfaced as a clean isError MCP response.
   */
  async match(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const payload = await this.postJson(REST_MATCH, args);
      const result: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        result.structuredContent = payload as { [key: string]: unknown };
      }
      return result;
    } catch (err) {
      return asMcpText(`XDate REST match error: ${errorMessage(err)}`, true);
    }
  }

  /**
   * Forward a tool call to upstream MCP at /api2/McpData unchanged.
   * Used for filter, company_details, talkpoints, serff_search, serff_filing -
   * all of which work correctly upstream and don't need the REST-proxy translation.
   * Always returns a valid CallToolResult: upstream success unwrapped, upstream
   * errors and network errors converted to isError-flagged text content.
   */
  async mcpPassthrough(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // UIDs from REST /Search arrive percent-encoded (`%2B`, `%2F`) but the upstream
    // MCP at /api2/McpData wants raw `+`/`/`. Decode known UID-shaped fields before
    // forwarding. See PCT_ENCODED_FIELDS comment for the bug history.
    const decodedArgs = decodePctEncodedFields(args);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: decodedArgs },
    };
    let response: unknown;
    try {
      response = await this.postJson(MCP_FALLBACK, body);
    } catch (err) {
      return asMcpText(`Network error calling upstream MCP (${toolName}): ${errorMessage(err)}`, true);
    }

    if (response && typeof response === "object") {
      if ("result" in response) {
        const result = (response as { result: unknown }).result;
        if (isCallToolResult(result)) return result;
        return asMcpText(
          `Upstream MCP returned malformed result for ${toolName}: ${JSON.stringify(result)}`,
          true,
        );
      }
      if ("error" in response) {
        return asMcpText(
          `Upstream MCP error on ${toolName}: ${JSON.stringify((response as { error: unknown }).error)}`,
          true,
        );
      }
    }
    return asMcpText(
      `Unexpected upstream response shape for ${toolName}: ${JSON.stringify(response)}`,
      true,
    );
  }

  private async postJson(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-API-Key": this.apiKey,
      ...extraHeaders,
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // 30s timeout: avoids the "looks like the client disconnected" symptom when
      // XDate is slow. Aborts the underlying socket cleanly.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      // HTTP error (401, 403, 429, 5xx). Body may still be JSON, but we treat
      // any non-2xx as a failure so the handler returns isError instead of
      // wrapping an error body as a successful result.
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
