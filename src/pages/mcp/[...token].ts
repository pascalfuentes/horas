import type { APIRoute } from "astro";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { authenticateToken, tokenFromHeader } from "~/lib/api-tokens";
import { createStore } from "~/lib/horas";
import { jsonError } from "~/lib/horas-api";
import { createMcpServer } from "~/lib/horas-mcp";
import { PERMISSIONS, can } from "~/lib/permissions";

export const prerender = false;

/**
 * Servidor MCP remoto (Streamable HTTP, stateless).
 *
 * Duas formas de autenticar, para caber em qualquer cliente:
 *   POST /mcp            com  Authorization: Bearer hrs_…   (preferida)
 *   POST /mcp/hrs_…      token na URL, para clientes que só aceitam uma URL
 *
 * Stateless: cada requisição monta o servidor, responde em JSON e termina. Não
 * há sessão MCP para guardar, o que é exatamente o que um Worker quer.
 */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const portador = await authenticateToken(locals.env, tokenFromHeader(request) ?? params.token ?? null);
  if (!portador) {
    const resposta = jsonError("Token ausente ou inválido.", 401);
    resposta.headers.set("www-authenticate", "Bearer");
    return resposta;
  }

  const store = createStore(locals.env.DB, {
    workspaceId: portador.workspaceId,
    userId: portador.userId,
    tz: portador.tz,
  });

  const servidor = createMcpServer(store, can(portador.role, PERMISSIONS.CONTENT_WRITE));
  const transporte = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await servidor.connect(transporte);
  return transporte.handleRequest(request);
};

/** Sem stream iniciado pelo servidor nem sessão para encerrar. */
const naoSuportado: APIRoute = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
    status: 405,
    headers: { allow: "POST", "content-type": "application/json" },
  });

export const GET = naoSuportado;
export const DELETE = naoSuportado;
