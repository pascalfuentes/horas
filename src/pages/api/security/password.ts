import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/security";

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const atual = str(form, "current_password");
  const nova = str(form, "new_password");
  const confirma = str(form, "confirm");

  if (!atual || !nova) return fail(PAGE, "fields");
  if (nova.length < 10) return fail(PAGE, "password_short");
  if (nova !== confirma) return fail(PAGE, "password_mismatch");

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
        code === "credentials" ? "current_password" : code,
      );
    }

    await audit(locals.env, {
      action: AUDIT.SELF_PASSWORD_CHANGED,
      actorId: me.id,
      actorEmail: me.email,
      targetId: me.id,
      request,
    });

    return handleAuthResponse(res, `${PAGE}?ok=ok_password`, PAGE);
  } catch (error) {
    const code = codeFromAuthError(error);
    return fail(PAGE, code === "credentials" ? "current_password" : code);
  }
};
