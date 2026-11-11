import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, isEmail, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const novo = str(form, "email").toLowerCase();
  if (!isEmail(novo)) return fail("/dashboard/security", "invalid_email");

  const me = actor(locals);
  if (novo === me.email.toLowerCase()) return ok("/dashboard/security", "ok_email");

  try {
    // O link de confirmação vai para o e-mail ATUAL, não para o novo. Quem
    // não controla a conta hoje não consegue mudar o endereço dela.
    await locals.auth.api.changeEmail({
      body: { newEmail: novo, callbackURL: "/dashboard/security?ok=ok_email" },
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
    details: { novoEmail: novo },
    request,
  });

  return ok("/dashboard/security", "ok_email");
};
