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
 * BYOK (MCP_BYOK=1): the server holds no key; each request carries the
 * caller's own InsuranceXDate API key, which is used for that request only -
 * never stored, never logged. Two transports for the credential:
 *   - `Authorization: Bearer <key>` on POST /mcp (clients that support
 *     custom headers: Claude Code, Cursor, the Claude API MCP connector)
 *   - POST /mcp/<key> (clients that only take a URL, e.g. claude.ai custom
 *     connectors - the Zapier-style capability URL)
 * The key IS the auth: a request without a valid-shaped key gets 401.
 *
 * Env: PORT (defaults to DEFAULT_PORT), XDATE_DISABLE_PAID (optional,
 * instance-wide, see tools.ts). Private mode: INSURANCEXDATE_API_KEY and
 * MCP_PATH_TOKEN (>=16 chars) required. BYOK mode: MCP_BYOK=1, and both
 * private-mode vars must be UNSET (refuses to start otherwise, so a shared
 * key can never silently back a BYOK deployment).
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extracts the caller's API key in BYOK mode: Authorization header first,
 * then the URL path segment. Returns null when absent or implausibly shaped
 * (charset per API_KEY_CHARSET - see server.ts on why that matters).
 */
function byokCredential(req: IncomingMessage, pathSegment: string | null): string | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  const candidate = bearer || (pathSegment ? decodeURIComponent(pathSegment) : null);
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
      console.error(
        "MCP_BYOK=1 is incompatible with INSURANCEXDATE_API_KEY / MCP_PATH_TOKEN. A BYOK server must hold no key of its own - unset them (or drop MCP_BYOK for a private instance).",
      );
      process.exit(1);
    }
  } else {
    sharedClient = new XdateClient(readApiKeyOrExit());
    pathToken = readPathTokenOrExit();
  }
  warnIfDisablePaidUnrecognized();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    const pathMatch = url.pathname.match(/^\/mcp(?:\/([^/]+))?$/);
    const pathSegment = pathMatch?.[1] ?? null;

    let client: XdateClient;
    if (byokMode) {
      if (!pathMatch) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const credential = byokCredential(req, pathSegment);
      if (!credential) {
        // Missing/implausible key. 401 so MCP clients surface "auth needed"
        // rather than a generic failure.
        res
          .writeHead(401, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "This is a bring-your-own-key server: send your InsuranceXDate API key as `Authorization: Bearer <key>` to /mcp, or use the URL form /mcp/<key>.",
              },
              id: null,
            }),
          );
        return;
      }
      client = new XdateClient(credential);
    } else {
      // Private mode: 404 (not 401/403) for a bad or missing token - don't
      // confirm the path shape to scanners.
      if (!pathSegment || !pathToken || !tokenMatches(decodeURIComponent(pathSegment), pathToken)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      client = sharedClient as XdateClient;
    }

    if (req.method !== "POST") {
      // Stateless mode has no GET event stream and no DELETE-able session.
      res
        .writeHead(405, { "content-type": "application/json", allow: "POST" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      console.log(JSON.stringify({ evt: "request", status: 400, error: err instanceof Error ? err.message : "parse", durationMs: Math.round(performance.now() - started) }));
      return;
    }

    const server = createServer(client);
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

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("insurancexdate HTTP handler error:", err);
      if (!res.headersSent) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.log(JSON.stringify({ evt: "listening", port, mode: byokMode ? "byok" : "private" }));
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
