import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const token = str(form, "token");
  if (!token) return fail("/dashboard/security", "fields");

  try {
    // Better Auth only revokes the user's own sessions through this route.
    await locals.auth.api.revokeSession({ body: { token }, headers: request.headers });
  } catch (error) {
    return fail("/dashboard/security", codeFromAuthError(error));
  }

  const me = actor(locals);
  await audit(locals.env, {
    action: AUDIT.SELF_SESSION_REVOKED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    request,
  });

  return ok("/dashboard/security", "ok_session");
};
