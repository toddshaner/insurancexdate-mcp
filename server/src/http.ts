#!/usr/bin/env node
/**
 * InsuranceXDate MCP server, remote streamable-HTTP entrypoint - for hosting
 * a shared instance instead of a per-machine stdio process. For the stdio
 * entrypoint, see index.ts.
 *
 * Stateless mode: each POST creates a fresh McpServer + transport pair
 * (sessionIdGenerator: undefined), so any instance can serve any request and
 * horizontal scaling needs no session affinity. The XdateClient holds no
 * per-caller state beyond the API key.
 *
 * Two mutually exclusive auth modes, chosen at startup:
 *
 * PRIVATE (default): one operator-held key from INSURANCEXDATE_API_KEY,
 * gated by a capability URL - requests must POST to
 * /mcp/<MCP_PATH_TOKEN>. This is suitable for a single operator or a tightly
 * controlled service-to-service deployment. The capability URL is not
 * per-user authentication; do not share it org-wide without vendor-approved
 * delegation. Treat the full URL as a credential.
 *
 * BYOK (MCP_BYOK=1): the server uses no key of its own; each request
 * carries the caller's own InsuranceXDate API key, which is used for that
 * request only and is neither stored nor written to this application's logs.
 * URL-form credentials can still be recorded by clients, proxies, or hosting
 * infrastructure. Private-mode env vars, if a platform leaves them behind,
 * are ignored with a loud warning. Two
 * transports for the credential:
 *   - `Authorization: Bearer <key>` on POST /mcp (clients that support
 *     custom headers: Claude Code, Cursor, the Claude API MCP connector)
 *   - POST /mcp/<key> (clients that only take a URL, e.g. claude.ai custom
 *     connectors - the Zapier-style capability URL)
 * The key IS the auth: a request without a valid-shaped key gets 401.
 *
 * Rate limiting (both modes; see rate-limit.ts): a per-credential token
 * bucket - the caller's key in BYOK mode, the path token in private mode -
 * charged one token per JSON-RPC request the POST body carries, so a batch
 * of N costs N. BYOK mode adds a host-wide backstop bucket across all keys,
 * since anyone can mint fresh valid-shaped keys; private mode has a single
 * credential, so the per-credential bucket already is the host-wide cap.
 * A set-but-invalid limit value refuses to start (fail closed).
 *
 * Env: PORT (defaults to DEFAULT_PORT), XDATE_DISABLE_PAID (instance-wide,
 * default disabled; set to an explicit false value to allow paid tools, see
 * tools.ts). Private mode: INSURANCEXDATE_API_KEY and
 * MCP_PATH_TOKEN (>=16 chars) required. BYOK mode: MCP_BYOK=1 (private-mode
 * vars, if also present, are ignored with a warning). Both modes:
 * MCP_RATE_LIMIT_PER_MIN tunes the per-credential limit (defaults to
 * DEFAULT_RATE_LIMIT_PER_MIN, 0 disables). BYOK mode:
 * MCP_GLOBAL_RATE_LIMIT_PER_MIN tunes the host-wide backstop (defaults to
 * GLOBAL_RATE_LIMIT_MULTIPLIER x the per-credential limit, 0 disables).
 * BYOK mode also serves a neutral disclosure page at GET /; private
 * instances stay dark on every non-MCP path.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  DEFAULT_RATE_LIMIT_PER_MIN,
  GLOBAL_RATE_LIMIT_MULTIPLIER,
  parseRateLimit,
  RateLimiter,
  requestCost,
} from "./rate-limit.js";
import { API_KEY_CHARSET, createServer, readApiKeyOrExit } from "./server.js";
import { isTruthy, warnIfDisablePaidUnrecognized } from "./tools.js";
import { XdateClient } from "./xdate-client.js";

const DEFAULT_PORT = 8080;
const MIN_TOKEN_LENGTH = 16;
// JSON-RPC requests are small; anything larger is malformed or hostile.
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_BODY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INFLIGHT_REQUESTS = 64;
const MAX_LOG_FIELD_CHARS = 80;
const MAX_LOG_ITEMS = 16;
const INGRESS_RATE_LIMIT_PER_MIN = 600;
// Sanity bounds for a caller-supplied key in BYOK mode; loose on purpose so
// upstream key-format changes don't strand callers.
const MIN_BYOK_KEY_LENGTH = 8;
const MAX_BYOK_KEY_LENGTH = 256;

// Served at GET / in BYOK mode only: a neutral disclosure page so the
// endpoint is accountable without being attributable. Private instances
// stay dark (404) on every non-MCP path.
const BYOK_LANDING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>InsuranceXDate MCP relay</title>
<style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#222}h1{font-size:1.4rem}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>InsuranceXDate MCP relay</h1>
<p>A hosted <a href="https://modelcontextprotocol.io">MCP</a> endpoint for the
InsuranceXDate API. Bring your own key: requests authenticate with your own
InsuranceXDate API key, which this application uses only for your request and
does not persist or write to its application logs. Your usage bills your own
InsuranceXDate account.</p>
<p>Connect an MCP client with <code>Authorization: Bearer &lt;your-key&gt;</code>
against <code>/mcp</code>, or use <code>/mcp/&lt;your-key&gt;</code> where only a
URL can be configured. Prefer the header form because clients, proxies, and
hosting infrastructure may record URLs.</p>
<p>Connections are free-only by default. If the operator has enabled paid
tools, append <code>?paid=1</code> to expose the six paid tools
($0.05&ndash;$0.25/call upstream, billed to your key, priced in their titles).
MCP clients are not guaranteed to prompt before each call.</p>
<p>Operational logging is limited to tool names, response status, and timing.
This application does not write query contents, results, or credentials to its
logs. Infrastructure outside the application may log URL-form credentials.
Requests are rate-limited per key.</p>
<p>This service is not affiliated with or endorsed by Insurance Xdate. Server
source code: <a href="https://github.com/toddshaner/insurancexdate-mcp">insurancexdate-mcp</a>
&mdash; self-hosting instructions included.</p>
</body></html>`;

function readPathTokenOrExit(): string {
  const token = process.env.MCP_PATH_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error(
      `MCP_PATH_TOKEN environment variable is required and must be at least ${MIN_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 24\`). Refusing to start an unauthenticated server. (For a bring-your-own-key server, set MCP_BYOK=1 instead.)`,
    );
    process.exit(1);
  }
  return token;
}

/**
 * Reads a rate-limit env var: unset/blank means the given default; a value
 * that doesn't parse as a non-negative number refuses to start. Failing open
 * here (the pre-fix behavior: Number("abc") is NaN, and NaN comparisons let
 * every request through) would silently disable the limiter on a typo.
 */
function readRateLimitOrExit(name: string, defaultPerMin: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultPerMin;
  const value = parseRateLimit(raw);
  if (value === null) {
    console.error(
      `${name} must be a non-negative number of requests per minute (0 disables); got ${JSON.stringify(raw)}. Refusing to start with an unenforceable rate limit.`,
    );
    process.exit(1);
  }
  return value;
}

function tokenMatches(candidate: string, token: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * decodeURIComponent that returns null on malformed percent-encoding instead
 * of throwing. The raw form throws URIError on e.g. /mcp/%, which - unhandled
 * in the request path - killed the whole process (one crafted request = DoS).
 */
function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Extracts the caller's API key in BYOK mode: Authorization header first,
 * then the URL path segment. Returns null when absent or implausibly shaped
 * (charset per API_KEY_CHARSET - see server.ts on why that matters).
 */
function plausibleByokCredential(value: string | null): value is string {
  return !!value &&
    value.length >= MIN_BYOK_KEY_LENGTH &&
    value.length <= MAX_BYOK_KEY_LENGTH &&
    API_KEY_CHARSET.test(value);
}

/** Exactly one credential channel is accepted; ambiguity is rejected. */
function byokCredential(req: IncomingMessage, pathSegment: string | null): string | null {
  const header = req.headers.authorization;
  const bearer = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : null;
  const pathCredential = pathSegment ? safeDecodeURIComponent(pathSegment) : null;
  if (bearer !== null && pathCredential !== null) return null;
  const candidate = bearer ?? pathCredential;
  return plausibleByokCredential(candidate) ? candidate : null;
}

/** Bucket id for a credential: hashed so raw keys never sit in a long-lived map. */
function bucketId(credential: string): string {
  return createHash("sha256").update(credential).digest("base64url").slice(0, 16);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>): void {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

class BodyReadError extends Error {
  constructor(readonly code: "invalid" | "too_large" | "timeout") {
    super(code);
  }
}

async function readBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    req.pause();
    throw new BodyReadError("too_large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: BodyReadError) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new BodyReadError("too_large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BodyReadError("invalid"));
      }
    };
    const onError = () => fail(new BodyReadError("invalid"));
    const onAborted = () => fail(new BodyReadError("invalid"));
    const timeout = setTimeout(() => fail(new BodyReadError("timeout")), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

/** A parsed POST body as the JSON-RPC requests it carries (batch = many). */
function asBatch(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

/** Names of tools/call targets in the request, for the access log. */
function safeLogField(value: string): string {
  return value.slice(0, MAX_LOG_FIELD_CHARS).replace(/[\u0000-\u001f\u007f]/g, "?");
}

const LOGGABLE_METHODS = new Set([
  "initialize",
  "notifications/cancelled",
  "notifications/initialized",
  "notifications/progress",
  "ping",
  "tools/call",
  "tools/list",
]);
const LOGGABLE_TOOLS = new Set([
  "benefits_search",
  "company_details",
  "filter",
  "flagged_companies",
  "group_companies",
  "groups",
  "match",
  "run_saved_search",
  "saved_searches",
  "search",
  "serff_filing",
  "serff_search",
  "talkpoints",
]);

function calledTools(body: unknown): string[] {
  return asBatch(body).slice(0, MAX_LOG_ITEMS).flatMap((r) => {
    if (typeof r !== "object" || r === null) return [];
    const { method, params } = r as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call") return [];
    return typeof params?.name === "string" && LOGGABLE_TOOLS.has(params.name)
      ? [safeLogField(params.name)]
      : [];
  });
}

function jsonRpcMethods(body: unknown): string[] {
  return asBatch(body).slice(0, MAX_LOG_ITEMS).flatMap((r) => {
    const method = (r as { method?: unknown } | null)?.method;
    return typeof method === "string" && LOGGABLE_METHODS.has(method)
      ? [safeLogField(method)]
      : [];
  });
}

function readCsvEnvOrExit(name: string): string[] {
  const values = (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    console.error(`${name} is required for the remote MCP endpoint.`);
    process.exit(1);
  }
  return values;
}

function readPositiveIntegerOrExit(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer.`);
    process.exit(1);
  }
  return value;
}

function readAllowedHostsOrExit(): Set<string> {
  const values = readCsvEnvOrExit("MCP_ALLOWED_HOSTS");
  const validHost = (value: string): boolean => {
    if (value !== value.toLowerCase()) return false;
    const parts = value.split(":");
    if (parts.length > 2 || !/^[a-z0-9.-]+$/.test(parts[0])) return false;
    if (parts.length === 1) return true;
    const port = Number(parts[1]);
    return /^\d{1,5}$/.test(parts[1]) && port >= 1 && port <= 65_535;
  };
  if (values.some((value) => !validHost(value))) {
    console.error("MCP_ALLOWED_HOSTS must contain comma-separated lowercase host[:port] values without schemes or paths.");
    process.exit(1);
  }
  return new Set(values);
}

function readAllowedOriginsOrExit(): Set<string> {
  const values = readCsvEnvOrExit("MCP_ALLOWED_ORIGINS");
  const normalized: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value || url.username || url.password) {
        throw new Error("invalid");
      }
      normalized.push(url.origin);
    } catch {
      console.error("MCP_ALLOWED_ORIGINS must contain comma-separated exact http(s) origins without paths, credentials, query strings, or fragments.");
      process.exit(1);
    }
  }
  return new Set(normalized);
}

function validMcpHeaders(req: IncomingMessage, allowedHosts: Set<string>, allowedOrigins: Set<string>): boolean {
  const host = req.headers.host?.toLowerCase();
  if (!host) return false;
  const separator = host.lastIndexOf(":");
  const port = separator > 0 ? host.slice(separator + 1) : "";
  const hostname = /^\d{1,5}$/.test(port) ? host.slice(0, separator) : host;
  // A hostname-only entry permits that hostname on any port, which keeps
  // localhost/ephemeral-port deployments usable. An entry with a port is
  // exact. In neither case can the request's Host authorize itself.
  if (!allowedHosts.has(host) && !allowedHosts.has(hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsedOrigin = new URL(origin).origin;
    return allowedOrigins.has(parsedOrigin) && parsedOrigin === origin;
  } catch {
    return false;
  }
}

function validMcpMediaHeaders(req: IncomingMessage): "ok" | "content_type" | "accept" {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return "content_type";
  const accepted = new Set(
    (req.headers.accept ?? "")
      .split(",")
      .map((value) => value.split(";", 1)[0]?.trim().toLowerCase())
      .filter(Boolean),
  );
  return accepted.has("application/json") && accepted.has("text/event-stream") ? "ok" : "accept";
}

async function main() {
  const byokMode = isTruthy(process.env.MCP_BYOK);

  let sharedApiKey: string | null = null;
  let pathToken: string | null = null;
  if (byokMode) {
    if (process.env.INSURANCEXDATE_API_KEY || process.env.MCP_PATH_TOKEN) {
      // Warn-and-ignore rather than exit: some platforms (e.g. App Runner
      // updates) merge old env/secrets into a new revision, and a hard exit
      // turns that leftover into a crash-looped deploy + rollback. The
      // guarantee stands either way: in BYOK mode these values are never
      // read again - every request uses only the credential it carried.
      console.error(
        "MCP_BYOK=1: ignoring INSURANCEXDATE_API_KEY / MCP_PATH_TOKEN found in the environment. A BYOK server uses only per-request keys - remove them from the deployment config.",
      );
    }
  } else {
    sharedApiKey = readApiKeyOrExit();
    pathToken = readPathTokenOrExit();
  }
  warnIfDisablePaidUnrecognized();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const rateLimitPerMin = readRateLimitOrExit("MCP_RATE_LIMIT_PER_MIN", DEFAULT_RATE_LIMIT_PER_MIN);
  const keyLimiter = new RateLimiter(rateLimitPerMin);
  // BYOK only: fabricated keys each mint a fresh per-key bucket, so a
  // host-wide bucket caps the total. Private mode's single credential makes
  // the per-credential bucket host-wide already.
  const globalLimitPerMin = byokMode
    ? readRateLimitOrExit("MCP_GLOBAL_RATE_LIMIT_PER_MIN", rateLimitPerMin * GLOBAL_RATE_LIMIT_MULTIPLIER)
    : 0;
  const globalLimiter = new RateLimiter(globalLimitPerMin);
  const ingressLimitPerMin = readPositiveIntegerOrExit("MCP_INGRESS_RATE_LIMIT_PER_MIN", Math.max(INGRESS_RATE_LIMIT_PER_MIN, globalLimitPerMin));
  const ingressLimiter = new RateLimiter(ingressLimitPerMin, 1);
  const allowedHosts = readAllowedHostsOrExit();
  const allowedOrigins = readAllowedOriginsOrExit();
  const bodyTimeoutMs = readPositiveIntegerOrExit("MCP_BODY_TIMEOUT_MS", DEFAULT_BODY_TIMEOUT_MS);
  const maxInflightRequests = readPositiveIntegerOrExit("MCP_MAX_INFLIGHT_REQUESTS", DEFAULT_MAX_INFLIGHT_REQUESTS);
  let inflightRequests = 0;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    if (byokMode && req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(BYOK_LANDING_HTML);
      return;
    }

    const pathMatch = url.pathname.match(/^\/mcp(?:\/([^/]+))?$/);
    const pathSegment = pathMatch?.[1] ?? null;

    if (pathMatch && !validMcpHeaders(req, allowedHosts, allowedOrigins)) {
      jsonRpcError(res, 403, -32000, "Forbidden");
      return;
    }

    let credential: string;
    if (byokMode) {
      if (!pathMatch) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const callerKey = byokCredential(req, pathSegment);
      if (!callerKey) {
        // Missing/implausible key. 401 so MCP clients surface "auth needed"
        // rather than a generic failure.
        jsonRpcError(
          res,
          401,
          -32000,
          "This is a bring-your-own-key server: send your InsuranceXDate API key as `Authorization: Bearer <key>` to /mcp, or use the URL form /mcp/<key>.",
        );
        return;
      }
      credential = callerKey;
    } else {
      // Private mode: 404 (not 401/403) for a bad or missing token - don't
      // confirm the path shape to scanners. A malformed percent-encoding
      // decodes to null and lands here too.
      const decoded = pathSegment ? safeDecodeURIComponent(pathSegment) : null;
      if (!decoded || !pathToken || !tokenMatches(decoded, pathToken)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      credential = pathToken;
    }

    if (req.method !== "POST") {
      // Stateless mode has no GET event stream and no DELETE-able session.
      jsonRpcError(res, 405, -32000, "Method not allowed", { allow: "POST" });
      return;
    }

    const mediaHeaders = validMcpMediaHeaders(req);
    if (mediaHeaders === "content_type") {
      jsonRpcError(res, 415, -32000, "Content-Type must be application/json");
      return;
    }
    if (mediaHeaders === "accept") {
      jsonRpcError(res, 406, -32000, "Accept must include application/json and text/event-stream");
      return;
    }

    // Charge authenticated attempts before doing body work so malformed and
    // slow bodies cannot bypass all admission controls.
    if (!ingressLimiter.allow("host")) {
      jsonRpcError(res, 429, -32000, "Server is busy. Retry shortly.", { "retry-after": "60" });
      return;
    }
    if (inflightRequests >= maxInflightRequests) {
      jsonRpcError(res, 503, -32000, "Server is busy. Retry shortly.", { "retry-after": "1" });
      return;
    }
    inflightRequests += 1;
    let inflightReleased = false;
    const releaseInflight = () => {
      if (inflightReleased) return;
      inflightReleased = true;
      inflightRequests -= 1;
    };
    res.once("finish", releaseInflight);
    res.once("close", releaseInflight);

    let body: unknown;
    try {
      body = await readBody(req, bodyTimeoutMs);
    } catch (err) {
      const kind = err instanceof BodyReadError ? err.code : "invalid";
      const status = kind === "too_large" ? 413 : kind === "timeout" ? 408 : 400;
      const terminateConnection = kind !== "invalid";
      if (terminateConnection) {
        res.shouldKeepAlive = false;
        // Let the bounded error response flush before force-closing an unread
        // request stream; an immediate destroy can turn the intended 408/413
        // into an opaque client-side connection reset.
        res.once("finish", () => {
          const forceClose = setTimeout(() => req.destroy(), 100);
          forceClose.unref();
        });
      }
      if (!res.destroyed) {
        jsonRpcError(
          res,
          status,
          -32700,
          kind === "too_large" ? "Request body too large" : kind === "timeout" ? "Request timeout" : "Parse error",
          terminateConnection ? { connection: "close" } : undefined,
        );
      }
      console.log(JSON.stringify({ evt: "request", status, error: "invalid_body", durationMs: Math.round(performance.now() - started) }));
      return;
    }

    // Rate limiting sits after body parse so a JSON-RPC batch is charged per
    // request it carries - a batch of N costs N tokens, not 1. Charge order:
    // peek the host-wide backstop (no charge), charge the per-key bucket,
    // then charge the host bucket only once both passed. That blocks both
    // starvation modes: a global-level flood never mints per-key buckets,
    // and a key-throttled caller never drains the global budget out from
    // under everyone else. Synchronous throughout, so the peeked capacity
    // cannot vanish before the charge.
    const cost = requestCost(body);
    const globallyAllowed = globalLimiter.peek("host", cost);
    const allowed = globallyAllowed && keyLimiter.allow(bucketId(credential), cost);
    if (allowed) globalLimiter.allow("host", cost);
    if (!allowed) {
      jsonRpcError(
        res,
        429,
        -32000,
        globallyAllowed
          ? "Rate limit exceeded for this key. Retry shortly."
          : "Server is over its global rate limit. Retry shortly.",
        { "retry-after": "60" },
      );
      console.log(
        JSON.stringify({
          evt: "request",
          status: 429,
          rateLimited: true,
          scope: globallyAllowed ? "key" : "global",
          cost,
          durationMs: Math.round(performance.now() - started),
        }),
      );
      return;
    }

    // Paid tools are OPT-IN per caller: connections are free-only unless the
    // URL carries `?paid=1`, in which case the gated tools appear in
    // tools/list (price-labeled; the caller's key pays). Cannot widen past
    // the instance-wide XDATE_DISABLE_PAID kill switch. Note this protects
    // against accidental spend by legitimate callers, not against a stolen
    // key — an attacker can add the parameter themselves.
    const paidOptIn = isTruthy(url.searchParams.get("paid"));
    const requestAbort = new AbortController();
    const client = byokMode
      ? new XdateClient(credential, requestAbort.signal)
      : new XdateClient(sharedApiKey as string, requestAbort.signal);
    const server = createServer(client, { paidTools: paidOptIn });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      requestAbort.abort();
      // Access log after the response is fully written; one JSON line per
      // request so hosted log tooling (CloudWatch etc.) can filter by tool.
      // Never log the URL path or headers - in BYOK mode they carry the key.
      console.log(
        JSON.stringify({
          evt: "request",
          status: res.statusCode,
          attemptedMethods: jsonRpcMethods(body),
          attemptedTools: calledTools(body),
          durationMs: Math.round(performance.now() - started),
        }),
      );
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // Catch-all so no request - malformed URL, transport edge case, future
    // handler bug - can become an unhandled rejection that kills the process.
    handleRequest(req, res).catch((err) => {
      console.error("insurancexdate HTTP handler error", { kind: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    });
  });

  httpServer.listen(port, () => {
    // Report the bound port, not the requested one, so PORT=0 (ephemeral,
    // used by the integration tests) logs something connectable.
    const address = httpServer.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    console.log(JSON.stringify({ evt: "listening", port: boundPort, mode: byokMode ? "byok" : "private" }));
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
