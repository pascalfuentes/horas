import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, isEmail, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const newEmail = str(form, "email").toLowerCase();
  if (!isEmail(newEmail)) return fail("/dashboard/security", "invalid_email");

  const me = actor(locals);
  if (newEmail === me.email.toLowerCase()) return ok("/dashboard/security", "ok_email");

  try {
    // The confirmation link goes to the CURRENT email, not the new one. Whoever
    // does not control the account today cannot change its address.
    await locals.auth.api.changeEmail({
      body: { newEmail, callbackURL: "/dashboard/security?ok=ok_email" },
      headers: request.headers,
    });
  } catch (error) {
    return fail("/dashboard/security", codeFromAuthError(error));
  }

  await audit(locals.env, {
    action: AUDIT.SELF_EMAIL_CHANGE_REQUESTED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    details: { newEmail },
    request,
  });

  return ok("/dashboard/security", "ok_email");
};
