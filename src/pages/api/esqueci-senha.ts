import type { APIRoute } from "astro";

import { clientIp } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { fail, isEmail, ok, str, verifyTurnstile } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const email = str(form, "email").toLowerCase();

  if (!isEmail(email)) return fail("/esqueci-senha", "email_invalido");

  const human = await verifyTurnstile(
    locals.env.TURNSTILE_SECRET_KEY,
    str(form, "cf-turnstile-response"),
    clientIp(request),
  );
  if (!human) return fail("/esqueci-senha", "turnstile");

  try {
    await callAuth(locals.auth, request, "/request-password-reset", {
      email,
      redirectTo: "/redefinir-senha",
    });
  } catch (error) {
    // Silenciado de propósito. Responder diferente quando o e-mail não existe
    // transforma este formulário num verificador de contas.
    console.error("forgetPassword:", error);
  }

  return ok("/esqueci-senha", "ok_reset");
};
