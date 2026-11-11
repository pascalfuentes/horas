import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, handleAuthResponse, safeNext, str } from "~/lib/http";

export const prerender = false;

/**
 * Segundo fator no login. A sessão de verdade só nasce aqui — até este ponto
 * a pessoa tem apenas o cookie temporário que o /sign-in/email deixou.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const acao = str(form, "acao");
  const codigo = str(form, "codigo");
  const next = safeNext(str(form, "next"));
  const back = `/dois-fatores?next=${encodeURIComponent(next)}`;

  if (!codigo) return fail(back, "campos");

  const rota = acao === "backup" ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp";
  const corpo =
    acao === "backup"
      ? { code: codigo }
      : { code: codigo, trustDevice: str(form, "confiar") === "1" };

  const res = await callAuth(locals.auth, request, rota, corpo);
  // Código errado volta como Response 4xx, não como exceção.
  return handleAuthResponse(res, next, back);
};
