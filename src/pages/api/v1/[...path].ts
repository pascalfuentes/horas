import type { APIRoute } from "astro";

import { authenticateToken, tokenFromHeader } from "~/lib/api-tokens";
import { createStore } from "~/lib/horas";
import { jsonError, handleHoras } from "~/lib/horas-api";
import { PERMISSIONS, can } from "~/lib/permissions";

export const prerender = false;

/**
 * Public token API: `Authorization: Bearer hrs_…`.
 *
 * It does not go through the middleware's session gate (see the exception there):
 * here the authentication is the token, which resolves the person AND the
 * workspace at once. With no cookie involved, there is nothing to protect from CSRF.
 */
export const ALL: APIRoute = async ({ request, locals, params }) => {
  const bearer = await authenticateToken(locals.env, tokenFromHeader(request));
  if (!bearer) {
    const response = jsonError("Missing or invalid token. Send Authorization: Bearer <token>.", 401);
    response.headers.set("www-authenticate", "Bearer");
    return response;
  }

  const store = createStore(locals.env.DB, {
    workspaceId: bearer.workspaceId,
    userId: bearer.userId,
    tz: request.headers.get("x-timezone") ?? bearer.tz,
  });

  return handleHoras(request, store, params.path ?? "", can(bearer.role, PERMISSIONS.CONTENT_WRITE));
};
