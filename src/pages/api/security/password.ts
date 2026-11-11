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
  const currentPassword = str(form, "current_password");
  const newPassword = str(form, "new_password");
  const confirm = str(form, "confirm");

  if (!currentPassword || !newPassword) return fail(PAGE, "fields");
  if (newPassword.length < 10) return fail(PAGE, "password_short");
  if (newPassword !== confirm) return fail(PAGE, "password_mismatch");

  const me = actor(locals);

  try {
    const res = await callAuth(locals.auth, request, "/change-password", {
      currentPassword,
      newPassword,
      // Changing the password is only worth it if it kicks out whoever was already in.
      revokeOtherSessions: true,
    });

    // A wrong current password comes back as a 400/401 Response, not as an exception.
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
