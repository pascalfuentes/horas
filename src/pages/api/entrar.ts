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
  const password = str(form, "senha");
  const next = safeNext(str(form, "next"));
  const back = `/login?next=${encodeURIComponent(next)}`;

  if (!isEmail(email) || !password) return fail(back, "campos");

  const human = await verifyTurnstile(
    locals.env.TURNSTILE_SECRET_KEY,
    str(form, "cf-turnstile-response"),
    clientIp(request),
  );
  if (!human) return fail(back, "turnstile");

  try {
    const res = await callAuth(locals.auth, request, "/sign-in/email", { email, password });
    // Credenciais erradas chegam como Response 401, não como exceção.
    // Mensagem genérica de propósito: não revela se o e-mail existe.
    if (!res.ok) return handleAuthResponse(res, next, back);

    // Senha certa mas a conta tem 2FA: o Better Auth ainda não abriu sessão,
    // só deixou um cookie temporário. Falta o segundo fator.
    const corpo = (await res.clone().json().catch(() => null)) as
      | { twoFactorRedirect?: boolean }
      | null;
    if (corpo?.twoFactorRedirect) {
      return redirectWithCookies(res, `/dois-fatores?next=${encodeURIComponent(next)}`);
    }

    return redirectWithCookies(res, next);
  } catch (error) {
    return fail(back, codeFromAuthError(error));
  }
};
