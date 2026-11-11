import type { APIRoute } from "astro";

import { clientIp } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { fail, isEmail, ok, str, verifyTurnstile } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const email = str(form, "email").toLowerCase();

  if (!isEmail(email)) return fail("/forgot-password", "invalid_email");

  const human = await verifyTurnstile(
    locals.env.TURNSTILE_SECRET_KEY,
    str(form, "cf-turnstile-response"),
    clientIp(request),
  );
  if (!human) return fail("/forgot-password", "turnstile");

  try {
    await callAuth(locals.auth, request, "/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
  } catch (error) {
    // Silenciado de propósito. Responder diferente quando o e-mail não existe
    // transforma este formulário num verificador de contas.
    console.error("forgetPassword:", error);
  }

  return ok("/forgot-password", "ok_reset");
};
