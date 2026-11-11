import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/security";
const SETUP = "/dashboard/security/2fa";

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const acao = str(form, "action");
  const me = actor(locals);

  try {
    if (acao === "confirm") {
      const codigo = str(form, "code");
      if (!codigo) return fail(SETUP, "fields");

      // Só aqui o 2FA passa a valer de verdade: `enable` gerou o segredo, mas
      // `twoFactorEnabled` continua falso até um código ser aceito.
      const res = await callAuth(locals.auth, request, "/two-factor/verify-totp", {
        code: codigo,
      });
      if (!res.ok) return handleAuthResponse(res, SETUP, SETUP);

      await audit(locals.env, {
        action: AUDIT.SELF_2FA_ENABLED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: me.id,
        request,
      });
      return handleAuthResponse(res, `${PAGE}?ok=ok_2fa_enabled`, SETUP);
    }

    if (acao === "disable") {
      const senha = str(form, "password");
      if (!senha) return fail(PAGE, "fields");

      const res = await callAuth(locals.auth, request, "/two-factor/disable", {
        password: senha,
      });
      if (!res.ok) {
        return handleAuthResponse(res, PAGE, PAGE, (c) =>
          c === "credentials" ? "current_password" : c,
        );
      }

      await audit(locals.env, {
        action: AUDIT.SELF_2FA_DISABLED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: me.id,
        request,
      });
      return ok(PAGE, "ok_2fa_disabled");
    }

    return fail(PAGE, "fields");
  } catch (error) {
    console.error("seguranca/2fa:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
