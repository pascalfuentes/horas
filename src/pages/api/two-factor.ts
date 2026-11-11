import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, handleAuthResponse, safeNext, str } from "~/lib/http";

export const prerender = false;

/**
 * Second factor at login. The real session is only born here — up to this
 * point the person has just the temporary cookie that /sign-in/email left.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const action = str(form, "action");
  const code = str(form, "code");
  const next = safeNext(str(form, "next"));
  const back = `/two-factor?next=${encodeURIComponent(next)}`;

  if (!code) return fail(back, "fields");

  const route = action === "backup" ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp";
  const body =
    action === "backup"
      ? { code }
      : { code, trustDevice: str(form, "trust") === "1" };

  const res = await callAuth(locals.auth, request, route, body);
  // A wrong code comes back as a 4xx Response, not as an exception.
  return handleAuthResponse(res, next, back);
};
