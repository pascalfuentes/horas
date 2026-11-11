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
  const action = str(form, "action");
  const me = actor(locals);

  try {
    if (action === "confirm") {
      const code = str(form, "code");
      if (!code) return fail(SETUP, "fields");

      // Only here does 2FA really take effect: `enable` generated the secret,
      // but `twoFactorEnabled` stays false until a code is accepted.
      const res = await callAuth(locals.auth, request, "/two-factor/verify-totp", {
        code,
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

    if (action === "disable") {
      const password = str(form, "password");
      if (!password) return fail(PAGE, "fields");

      const res = await callAuth(locals.auth, request, "/two-factor/disable", {
        password,
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
    console.error("security/2fa:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
