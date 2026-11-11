import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, isEmail, ok, str } from "~/lib/http";

export const prerender = false;

/**
 * Reenvia o link de verificação. Responde igual para endereço existente,
 * inexistente ou já verificado — senão viraria um verificador de contas, do
 * mesmo jeito que o `/forgot-password` já evita ser.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const email = str(await request.formData(), "email").toLowerCase();
  if (!isEmail(email)) return fail("/verify-email", "invalid_email");

  try {
    await callAuth(locals.auth, request, "/send-verification-email", {
      email,
      callbackURL: "/login?ok=ok_email_verified",
    });
  } catch (error) {
    // Silenciado de propósito: ver comentário acima.
    console.error("reenviar-verificacao:", error);
  }

  return ok("/verify-email", "ok_verification_resent");
};
