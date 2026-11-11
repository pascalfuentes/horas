import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, denyConta } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/seguranca";

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyConta(locals);
  if (denied) return denied;

  const form = await request.formData();
  const atual = str(form, "atual");
  const nova = str(form, "nova");
  const confirma = str(form, "confirma");

  if (!atual || !nova) return fail(PAGE, "campos");
  if (nova.length < 10) return fail(PAGE, "senha_curta");
  if (nova !== confirma) return fail(PAGE, "senha_confirma");

  const me = actor(locals);

  try {
    const res = await callAuth(locals.auth, request, "/change-password", {
      currentPassword: atual,
      newPassword: nova,
      // Trocar a senha só vale a pena se derrubar quem já estava dentro.
      revokeOtherSessions: true,
    });

    // Senha atual errada volta como Response 400/401, não como exceção.
    if (!res.ok) {
      return handleAuthResponse(res, PAGE, PAGE, (code) =>
        code === "credenciais" ? "senha_atual" : code,
      );
    }

    await audit(locals.env, {
      action: AUDIT.SELF_PASSWORD_CHANGED,
      actorId: me.id,
      actorEmail: me.email,
      targetId: me.id,
      request,
    });

    return handleAuthResponse(res, `${PAGE}?ok=ok_senha`, PAGE);
  } catch (error) {
    const code = codeFromAuthError(error);
    return fail(PAGE, code === "credenciais" ? "senha_atual" : code);
  }
};
