/**
 * InsuranceXDate HTTP clients.
 *
 * Four fixed upstream routes:
 *   - /api2/Search   (REST)  - used for `search`, with translated param names
 *   - /api2/Match    (REST)  - used for `match`
 *   - /api2/Account  (REST)  - used only through the `account_status` allowlist
 *   - /api2/McpData  (MCP)   - passthrough for supported native tools
 *
 * Why search uses two routes: the upstream MCP at /api2/McpData advertises premfrom/premto/modfrom/modto/limit
 * on its `search` tool, but those values are not applied at runtime. The REST endpoint at
 * /api2/Search accepts equivalent params under different names (fromprem/toprem/frommod/
 * tomod/pagelimit) and applies them as documented in the OpenAPI spec. This client
 * translates between the two naming conventions for `search` only.
 *
 * Verified empirically 2026-04-25:
 *   MCP search with premfrom=10000000 returned pagination.total=33,353 (filter not applied).
 *   REST search with fromprem=10000000 returned 1 record (filter applied as documented).
 *
 * Re-verified 2026-07-03 (post-Q3): the upstream MCP's WC mode (datamode=0) now
 * applies premium/mod filters but DIVERGES from REST — NJ premfrom=1M returned 2
 * via MCP vs 112 via REST; modfrom=1.2 returned 4,743 vs 5,609. Head-to-head
 * cross-validation the same day showed the deeper problem: MCP dm0 searches a
 * SMALLER WC universe than REST (NJ baseline 83,143 vs 98,651; renewal window
 * 12,353 vs 15,085; classlist 8810: 2,550 vs 9,282; siclist 8051: 111 vs 136;
 * countylist essex: 6,739 vs 7,413). MCP dm0's name/naicslist filters DO work
 * (83,143 -> 1,208 / -> 900) but against that incomplete universe. REST remains
 * the recommended WC route; guarded native_search exposes the native route only
 * as an explicit advanced alternative. The MCP's datamode 1/2 (Form 5500
 * benefits) filters were verified working the same day and are exposed via the
 * focused benefits_search tool as well as the guarded advanced surface.
 *
 * Both public methods always return a valid CallToolResult. Errors are converted to
 * isError-flagged content so the SDK never sees a malformed shape.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://www.insurancexdate.com/api2";
const REST_SEARCH = `${API_BASE}/Search`;
const REST_MATCH = `${API_BASE}/Match`;
const REST_ACCOUNT = `${API_BASE}/Account`;
const MCP_FALLBACK = `${API_BASE}/McpData`;

/** REST `pagelimit` hard cap. Values above silently fall back to 10. */
const REST_PAGELIMIT_CAP = 50;

/** Per-fetch timeout. XDate can be slow; this prevents hangs from looking like client disconnects. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Bound upstream memory use even when a peer omits or lies about Content-Length. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ACCOUNT_STATUS_FIELDS = ["apiBalance", "apiFreeMonthly"] as const;

class UpstreamError extends Error {
  constructor(readonly kind: "http" | "invalid" | "too_large") {
    super(kind);
  }
}

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

type SafeScalar = string | number | null;

function safeScalar(value: unknown): SafeScalar {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return null;
}

export class XdateClient {
  constructor(private apiKey: string, private requestSignal?: AbortSignal) {
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
   * may return HTTP 4xx (unauthorized) for account/key/request problems even though XDate support confirmed no additional service is required for Match on
   * the active account; such errors are surfaced as clean isError MCP responses.
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
   * Read the account's prepaid-balance cluster without exposing the raw
   * /Account response. XDate also includes password/session/Stripe fields in
   * that object, so extraction is a fixed allowlist and only scalar values are
   * permitted into either MCP content surface.
   */
  async accountStatus(): Promise<CallToolResult> {
    try {
      const payload = await this.getJson(REST_ACCOUNT);
      const user = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { data?: unknown }).data
        : undefined;
      const account = user && typeof user === "object" && !Array.isArray(user)
        ? (user as { user?: unknown }).user
        : undefined;
      if (!account || typeof account !== "object" || Array.isArray(account)) {
        throw new UpstreamError("invalid");
      }
      const source = account as Record<string, unknown>;
      const status: Record<(typeof ACCOUNT_STATUS_FIELDS)[number], SafeScalar> = {
        apiBalance: null,
        apiFreeMonthly: null,
      };
      for (const field of ACCOUNT_STATUS_FIELDS) status[field] = safeScalar(source[field]);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    } catch (err) {
      return asMcpText(`XDate account status error: ${errorMessage(err)}`, true);
    }
  }

  /**
   * Forward a tool call to upstream MCP at /api2/McpData unchanged.
   * Used for the native read and action tools, including guarded native_search,
   * benefits_search (native `search` with datamode locked to 1|2), filter,
   * company/SERFF/workflow reads, add_note, and set_flag. None need the REST
   * search parameter translation. group_companies and run_saved_search pass
   * through but remain gated as unverified stored-content executors.
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
      return asMcpText(`Error calling upstream MCP (${toolName}): ${errorMessage(err)}`, true);
    }

    if (response && typeof response === "object") {
      if ("result" in response) {
        const result = (response as { result: unknown }).result;
        if (isCallToolResult(result)) return result;
        return asMcpText(`Upstream MCP returned an invalid result for ${toolName}.`, true);
      }
      if ("error" in response) {
        return asMcpText(`Upstream MCP rejected ${toolName}.`, true);
      }
    }
    return asMcpText(`Upstream MCP returned an invalid response for ${toolName}.`, true);
  }

  private async postJson(url: string, body: unknown): Promise<unknown> {
    return this.requestJson(url, "POST", body);
  }

  private async getJson(url: string): Promise<unknown> {
    return this.requestJson(url, "GET");
  }

  private async requestJson(url: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "X-API-Key": this.apiKey,
    };
    if (method === "POST") headers["Content-Type"] = "application/json";
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (this.requestSignal) signals.push(this.requestSignal);
    const response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      redirect: "error",
      // 30s timeout: avoids the "looks like the client disconnected" symptom when
      // XDate is slow. Aborts the underlying socket cleanly.
      signal: AbortSignal.any(signals),
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new UpstreamError("too_large");
    }
    if (!response.ok) {
      // Error bodies are not useful to callers and may contain sensitive or
      // arbitrarily large vendor diagnostics. Do not buffer them at all.
      await response.body?.cancel();
      throw new UpstreamError("http");
    }
    if (!response.body) throw new UpstreamError("invalid");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new UpstreamError("too_large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError("invalid");
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof UpstreamError) {
    if (err.kind === "too_large") return "upstream response exceeded the safety limit";
    if (err.kind === "http") return "upstream service rejected the request";
    return "upstream service returned an invalid response";
  }
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return "request cancelled or timed out";
  }
  return "upstream service unavailable";
}
