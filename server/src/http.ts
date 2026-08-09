#!/usr/bin/env node
/**
 * InsuranceXDate MCP server, remote streamable-HTTP entrypoint - for hosting
 * one shared instance (e.g. as a claude.ai organization custom connector)
 * instead of a per-machine stdio process. For the stdio entrypoint, see
 * index.ts.
 *
 * Stateless mode: each POST creates a fresh McpServer + transport pair
 * (sessionIdGenerator: undefined), so any instance can serve any request and
 * horizontal scaling needs no session affinity. The XdateClient is shared —
 * it holds no per-caller state, only the API key.
 *
 * Auth: claude.ai custom connectors offer OAuth or nothing, so the minimum
 * viable gate is a capability URL: requests must POST to /mcp/<MCP_PATH_TOKEN>.
 * Treat the full URL as a secret. Do not expose this server beyond your own
 * organization — every tool call spends the configured account's balance.
 *
 * Env: INSURANCEXDATE_API_KEY (required), MCP_PATH_TOKEN (required,
 * >=16 chars), PORT (defaults to DEFAULT_PORT), XDATE_DISABLE_PAID (optional,
 * see tools.ts).
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer, readApiKeyOrExit } from "./server.js";
import { warnIfDisablePaidUnrecognized } from "./tools.js";
import { XdateClient } from "./xdate-client.js";

const DEFAULT_PORT = 8080;
const MIN_TOKEN_LENGTH = 16;
// JSON-RPC requests are small; anything larger is malformed or hostile.
const MAX_BODY_BYTES = 1_048_576;

function readPathTokenOrExit(): string {
  const token = process.env.MCP_PATH_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error(
      `MCP_PATH_TOKEN environment variable is required and must be at least ${MIN_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 24\`). Refusing to start an unauthenticated server.`,
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
  const apiKey = readApiKeyOrExit();
  const pathToken = readPathTokenOrExit();
  warnIfDisablePaidUnrecognized();

  const client = new XdateClient(apiKey);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    const match = url.pathname.match(/^\/mcp\/([^/]+)$/);
    // 404 (not 401/403) for a bad token: don't confirm the path shape to scanners.
    if (!match || !tokenMatches(decodeURIComponent(match[1]), pathToken)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
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
    console.log(JSON.stringify({ evt: "listening", port }));
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
