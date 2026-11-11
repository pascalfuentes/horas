import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const token = str(form, "token");
  const senha = str(form, "password");
  const confirma = str(form, "confirm");
  const back = `/reset-password?token=${encodeURIComponent(token)}`;

  if (!token) return fail("/forgot-password", "invalid_invite");
  if (senha.length < 10) return fail(back, "password_short");
  if (senha !== confirma) return fail(back, "password_mismatch");

  const res = await callAuth(locals.auth, request, "/reset-password", {
    newPassword: senha,
    token,
  });
  if (!res.ok) return handleAuthResponse(res, "/login", back);

  // `revokeSessionsOnPasswordReset` já derrubou todas as sessões: entra de novo.
  return ok("/login", "ok_password");
};
