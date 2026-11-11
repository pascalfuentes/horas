import type { APIRoute } from "astro";

import { deny, actor, currentWorkspace } from "~/lib/guards";
import { createStore } from "~/lib/horas";
import { jsonError, handleHoras } from "~/lib/horas-api";
import { PERMISSIONS, can } from "~/lib/permissions";

export const prerender = false;

/**
 * Time tracking API for the WEB (cookie session).
 *
 * The workspace comes from the slug in the route — the middleware has already
 * checked the membership. The person comes from the session. Neither is accepted
 * from the request body.
 */
export const ALL: APIRoute = async ({ request, locals, params, url }) => {
  const denied = deny(locals, PERMISSIONS.CONTENT_READ);
  if (denied) return denied;

  // Astro's `checkOrigin` only covers forms. Here the body is JSON, so the
  // origin of every write is checked by hand.
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin !== url.origin) return jsonError("Origin not allowed.", 403);
  }

  const ws = currentWorkspace(locals);
  const store = createStore(locals.env.DB, {
    workspaceId: ws.workspaceId,
    userId: actor(locals).id,
    tz: request.headers.get("x-timezone") ?? undefined,
  });

  return handleHoras(request, store, params.path ?? "", can(ws.role, PERMISSIONS.CONTENT_WRITE));
};
