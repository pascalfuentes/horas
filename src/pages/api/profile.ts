import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { NAME_MAX, PHONE_MAX, codeFromAuthError, fail, nameCarriesLink, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  // Cut, not refused: nobody's name is longer than this, and what was stored
  // without a limit used to go whole into every page and e-mail that says it.
  const name = str(form, "name").slice(0, NAME_MAX);
  const phone = str(form, "phone").slice(0, PHONE_MAX);
  if (!name) return fail("/dashboard/profile", "fields");
  if (nameCarriesLink(name)) return fail("/dashboard/profile", "invalid_name");

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
