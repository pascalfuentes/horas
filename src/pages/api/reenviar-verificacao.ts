import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, isEmail, ok, str } from "~/lib/http";

export const prerender = false;

/**
 * Reenvia o link de verificação. Responde igual para endereço existente,
 * inexistente ou já verificado — senão viraria um verificador de contas, do
 * mesmo jeito que o `/esqueci-senha` já evita ser.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const email = str(await request.formData(), "email").toLowerCase();
  if (!isEmail(email)) return fail("/verificar-email", "email_invalido");

  try {
    await callAuth(locals.auth, request, "/send-verification-email", {
      email,
      callbackURL: "/login?ok=ok_email_verificado",
    });
  } catch (error) {
    // Silenciado de propósito: ver comentário acima.
    console.error("reenviar-verificacao:", error);
  }

  return ok("/verificar-email", "ok_verificacao_reenviada");
};
