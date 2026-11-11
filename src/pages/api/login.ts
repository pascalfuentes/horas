import type { APIRoute } from "astro";

import { clientIp } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import {
  codeFromAuthError,
  fail,
  handleAuthResponse,
  isEmail,
  redirectWithCookies,
  safeNext,
  str,
  verifyTurnstile,
} from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");
  const next = safeNext(str(form, "next"));
  const back = `/login?next=${encodeURIComponent(next)}`;

  if (!isEmail(email) || !password) return fail(back, "fields");

  const human = await verifyTurnstile(
    locals.env.TURNSTILE_SECRET_KEY,
    str(form, "cf-turnstile-response"),
    clientIp(request),
  );
  if (!human) return fail(back, "turnstile");

  try {
    const res = await callAuth(locals.auth, request, "/sign-in/email", { email, password });
    // Wrong credentials arrive as a 401 Response, not as an exception.
    // Generic message on purpose: it does not reveal whether the email exists.
    if (!res.ok) return handleAuthResponse(res, next, back);

    // Right password but the account has 2FA: Better Auth has not opened a
    // session yet, it only left a temporary cookie. The second factor is missing.
    const body = (await res.clone().json().catch(() => null)) as
      | { twoFactorRedirect?: boolean }
      | null;
    if (body?.twoFactorRedirect) {
      return redirectWithCookies(res, `/two-factor?next=${encodeURIComponent(next)}`);
    }

    return redirectWithCookies(res, next);
  } catch (error) {
    return fail(back, codeFromAuthError(error));
  }
};
