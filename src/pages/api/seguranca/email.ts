import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyConta } from "~/lib/guards";
import { codeFromAuthError, fail, isEmail, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyConta(locals);
  if (denied) return denied;

  const form = await request.formData();
  const novo = str(form, "email").toLowerCase();
  if (!isEmail(novo)) return fail("/dashboard/seguranca", "email_invalido");

  const me = actor(locals);
  if (novo === me.email.toLowerCase()) return ok("/dashboard/seguranca", "ok_email");

  try {
    // O link de confirmação vai para o e-mail ATUAL, não para o novo. Quem
    // não controla a conta hoje não consegue mudar o endereço dela.
    await locals.auth.api.changeEmail({
      body: { newEmail: novo, callbackURL: "/dashboard/seguranca?ok=ok_email" },
      headers: request.headers,
    });
  } catch (error) {
    return fail("/dashboard/seguranca", codeFromAuthError(error));
  }

  await audit(locals.env, {
    action: AUDIT.SELF_EMAIL_CHANGE_REQUESTED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    details: { novoEmail: novo },
    request,
  });

  return ok("/dashboard/seguranca", "ok_email");
};
