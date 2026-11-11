import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyConta } from "~/lib/guards";
import { codeFromAuthError, fail, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyConta(locals);
  if (denied) return denied;

  const form = await request.formData();
  const name = str(form, "nome");
  const phone = str(form, "telefone");
  if (!name) return fail("/dashboard/perfil", "campos");

  try {
    await locals.auth.api.updateUser({ body: { name, phone }, headers: request.headers });
  } catch (error) {
    return fail("/dashboard/perfil", codeFromAuthError(error));
  }

  const me = actor(locals);
  await audit(locals.env, {
    action: AUDIT.SELF_PROFILE_UPDATED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    request,
  });

  return ok("/dashboard/perfil", "ok_perfil");
};
