import type { APIRoute } from "astro";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { authenticateToken, tokenFromHeader } from "~/lib/api-tokens";
import { createStore } from "~/lib/horas";
import { jsonError } from "~/lib/horas-api";
import { createMcpServer } from "~/lib/horas-mcp";
import { PERMISSIONS, can } from "~/lib/permissions";

export const prerender = false;

/**
 * Remote MCP server (Streamable HTTP, stateless).
 *
 * Two ways to authenticate, to fit any client:
 *   POST /mcp            with Authorization: Bearer hrs_…   (preferred)
 *   POST /mcp/hrs_…      token in the URL, for clients that only accept a URL
 *
 * Stateless: each request builds the server, responds in JSON and ends. There
 * is no MCP session to keep, which is exactly what a Worker wants.
 */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const bearer = await authenticateToken(locals.env, tokenFromHeader(request) ?? params.token ?? null);
  if (!bearer) {
    const response = jsonError("Missing or invalid token.", 401);
    response.headers.set("www-authenticate", "Bearer");
    return response;
  }

  const store = createStore(locals.env.DB, {
    workspaceId: bearer.workspaceId,
    userId: bearer.userId,
    tz: bearer.tz,
  });

  const server = createMcpServer(store, can(bearer.role, PERMISSIONS.CONTENT_WRITE));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};

/** No server-initiated stream and no session to close. */
const notSupported: APIRoute = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json" },
  });

export const GET = notSupported;
export const DELETE = notSupported;
