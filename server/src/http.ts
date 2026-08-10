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
 * PRIVATE (default): one org-wide key from INSURANCEXDATE_API_KEY, gated by
 * a capability URL - requests must POST to /mcp/<MCP_PATH_TOKEN>. Suitable
 * for e.g. a claude.ai organization custom connector (OAuth or nothing, so
 * the secret URL is the minimum viable gate). Treat the full URL as a
 * credential.
 *
 * BYOK (MCP_BYOK=1): the server uses no key of its own; each request
 * carries the caller's own InsuranceXDate API key, which is used for that
 * request only - never stored, never logged. Private-mode env vars, if a
 * platform leaves them behind, are ignored with a loud warning. Two
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
 * Env: PORT (defaults to DEFAULT_PORT), XDATE_DISABLE_PAID (optional,
 * instance-wide, see tools.ts). Private mode: INSURANCEXDATE_API_KEY and
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
import { warnIfDisablePaidUnrecognized } from "./tools.js";
import { XdateClient } from "./xdate-client.js";

const DEFAULT_PORT = 8080;
const MIN_TOKEN_LENGTH = 16;
// JSON-RPC requests are small; anything larger is malformed or hostile.
const MAX_BODY_BYTES = 1_048_576;
// Sanity bounds for a caller-supplied key in BYOK mode; loose on purpose so
// upstream key-format changes don't strand callers.
const MIN_BYOK_KEY_LENGTH = 8;
const MAX_BYOK_KEY_LENGTH = 256;

const BYOK_TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);

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
InsuranceXDate API key, which is used for your request only &mdash; never stored,
never logged. Your usage bills your own InsuranceXDate account.</p>
<p>Connect an MCP client with <code>Authorization: Bearer &lt;your-key&gt;</code>
against <code>/mcp</code>, or use <code>/mcp/&lt;your-key&gt;</code> where only a
URL can be configured (e.g. claude.ai custom connectors).</p>
<p>Connections are free-only by default. To also expose the six paid tools
($0.05&ndash;$0.25/call upstream, billed to your key, priced in their titles),
append <code>?paid=1</code> to the URL.</p>
<p>Operational logging is limited to tool names, response status, and timing.
Query contents, results, and credentials are never logged. Requests are
rate-limited per key.</p>
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
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
function byokCredential(req: IncomingMessage, pathSegment: string | null): string | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  const candidate = bearer || (pathSegment ? safeDecodeURIComponent(pathSegment) : null);
  if (
    !candidate ||
    candidate.length < MIN_BYOK_KEY_LENGTH ||
    candidate.length > MAX_BYOK_KEY_LENGTH ||
    !API_KEY_CHARSET.test(candidate)
  ) {
    return null;
  }
  return candidate;
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Names of tools/call targets in the request, for the access log. */
function calledTools(body: unknown): string[] {
  const requests = Array.isArray(body) ? body : [body];
  return requests.flatMap((r) => {
    if (typeof r !== "object" || r === null) return [];
    const { method, params } = r as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call") return [];
    return typeof params?.name === "string" ? [params.name] : [];
  });
}

function jsonRpcMethods(body: unknown): string[] {
  const requests = Array.isArray(body) ? body : [body];
  return requests.flatMap((r) => {
    const method = (r as { method?: unknown } | null)?.method;
    return typeof method === "string" ? [method] : [];
  });
}

async function main() {
  const byokMode = BYOK_TRUTHY.has((process.env.MCP_BYOK ?? "").trim().toLowerCase());

  let sharedClient: XdateClient | null = null;
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
    sharedClient = new XdateClient(readApiKeyOrExit());
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

    let client: XdateClient;
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
      client = new XdateClient(callerKey);
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
      client = sharedClient as XdateClient;
    }

    if (req.method !== "POST") {
      // Stateless mode has no GET event stream and no DELETE-able session.
      jsonRpcError(res, 405, -32000, "Method not allowed", { allow: "POST" });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      jsonRpcError(res, 400, -32700, "Parse error");
      console.log(JSON.stringify({ evt: "request", status: 400, error: err instanceof Error ? err.message : "parse", durationMs: Math.round(performance.now() - started) }));
      return;
    }

    // Rate limiting sits after body parse so a JSON-RPC batch is charged per
    // request it carries - a batch of N costs N tokens, not 1. The host-wide
    // backstop is charged first; a request denied there never touches (or
    // creates) a per-key bucket.
    const cost = requestCost(body);
    const globallyAllowed = globalLimiter.allow("host", cost);
    const allowed = globallyAllowed && keyLimiter.allow(bucketId(credential), cost);
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
    const paidParam = (url.searchParams.get("paid") ?? "").trim().toLowerCase();
    const paidOptIn = ["1", "true", "yes", "on"].includes(paidParam);
    const server = createServer(client, { paidTools: paidOptIn });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      // Access log after the response is fully written; one JSON line per
      // request so hosted log tooling (CloudWatch etc.) can filter by tool.
      // Never log the URL path or headers - in BYOK mode they carry the key.
      console.log(
        JSON.stringify({
          evt: "request",
          status: res.statusCode,
          methods: jsonRpcMethods(body),
          tools: calledTools(body),
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
      console.error("insurancexdate HTTP handler error:", err);
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
