import type { APIRoute } from "astro";

import { deny, actor, currentWorkspace } from "~/lib/guards";
import { createStore } from "~/lib/horas";
import { jsonError, handleHoras } from "~/lib/horas-api";
import { PERMISSIONS, can } from "~/lib/permissions";

export const prerender = false;

/**
 * API do controle de tempo para a WEB (sessão por cookie).
 *
 * O workspace vem do slug na rota — o middleware já conferiu a membership. A
 * pessoa vem da sessão. Nenhum dos dois é aceito do corpo da requisição.
 */
export const ALL: APIRoute = async ({ request, locals, params, url }) => {
  const denied = deny(locals, PERMISSIONS.CONTENT_READ);
  if (denied) return denied;

  // O `checkOrigin` do Astro só cobre formulários. Aqui o corpo é JSON, então a
  // origem de toda escrita é conferida à mão.
  if (request.method !== "GET") {
    const origem = request.headers.get("origin");
    if (origem !== url.origin) return jsonError("Origem não permitida.", 403);
  }

  const ws = currentWorkspace(locals);
  const store = createStore(locals.env.DB, {
    workspaceId: ws.workspaceId,
    userId: actor(locals).id,
    tz: request.headers.get("x-timezone") ?? undefined,
  });

  return handleHoras(request, store, params.path ?? "", can(ws.role, PERMISSIONS.CONTENT_WRITE));
};
