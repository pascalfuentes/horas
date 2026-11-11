import type { APIRoute } from "astro";

import { authenticateToken, tokenFromHeader } from "~/lib/api-tokens";
import { createStore } from "~/lib/horas";
import { jsonError, handleHoras } from "~/lib/horas-api";
import { PERMISSIONS, can } from "~/lib/permissions";

export const prerender = false;

/**
 * API pública por token: `Authorization: Bearer hrs_…`.
 *
 * Não passa pelo portão de sessão do middleware (ver a exceção lá): aqui a
 * autenticação é o token, que resolve a pessoa E o workspace de uma vez.
 * Sem cookie envolvido, não há o que proteger de CSRF.
 */
export const ALL: APIRoute = async ({ request, locals, params }) => {
  const portador = await authenticateToken(locals.env, tokenFromHeader(request));
  if (!portador) {
    const resposta = jsonError("Token ausente ou inválido. Envie Authorization: Bearer <token>.", 401);
    resposta.headers.set("www-authenticate", "Bearer");
    return resposta;
  }

  const store = createStore(locals.env.DB, {
    workspaceId: portador.workspaceId,
    userId: portador.userId,
    tz: request.headers.get("x-timezone") ?? portador.tz,
  });

  return handleHoras(request, store, params.path ?? "", can(portador.role, PERMISSIONS.CONTENT_WRITE));
};
