import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const token = str(form, "token");
  const password = str(form, "password");
  const confirm = str(form, "confirm");
  const back = `/reset-password?token=${encodeURIComponent(token)}`;

  if (!token) return fail("/forgot-password", "invalid_invite");
  if (password.length < 10) return fail(back, "password_short");
  if (password !== confirm) return fail(back, "password_mismatch");

  const res = await callAuth(locals.auth, request, "/reset-password", {
    newPassword: password,
    token,
  });
  if (!res.ok) return handleAuthResponse(res, "/login", back);

  // `revokeSessionsOnPasswordReset` has already dropped every session: sign in again.
  return ok("/login", "ok_password");
};
