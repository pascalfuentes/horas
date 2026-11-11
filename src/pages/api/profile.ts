import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const name = str(form, "name");
  const phone = str(form, "phone");
  if (!name) return fail("/dashboard/profile", "fields");

  try {
    await locals.auth.api.updateUser({ body: { name, phone }, headers: request.headers });
  } catch (error) {
    return fail("/dashboard/profile", codeFromAuthError(error));
  }

  const me = actor(locals);
  await audit(locals.env, {
    action: AUDIT.SELF_PROFILE_UPDATED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    request,
  });

  return ok("/dashboard/profile", "ok_profile");
};
