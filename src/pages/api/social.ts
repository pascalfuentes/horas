import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { socialProviders } from "~/lib/env";
import { fail, redirectWithCookies, safeNext, str } from "~/lib/http";

export const prerender = false;

/**
 * Começa o fluxo OAuth. O Better Auth devolve a URL do provedor e os cookies
 * de `state`/PKCE — os dois precisam viajar juntos, senão o callback é
 * rejeitado por não reconhecer a requisição que o originou.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const provider = str(form, "provider");
  const next = safeNext(str(form, "next"));

  // A lista vem das chaves configuradas: um provedor sem credenciais não é
  // aceito nem que alguém forje o formulário.
  if (!socialProviders(locals.env).includes(provider as "google" | "github")) {
    return fail("/login", "social_unavailable");
  }

  const res = await callAuth(locals.auth, request, "/sign-in/social", {
    provider,
    callbackURL: next,
    newUserCallbackURL: next,
    // Para onde o provedor devolve quando algo dá errado — conta desativada,
    // e-mail já vinculado a outro método, autorização negada. O Better Auth
    // acrescenta `?error=<código>` aqui; a mensagem é genérica de propósito,
    // porque o código cru não diz nada a quem está na tela.
    errorCallbackURL: "/login?e=social_failed",
  });

  const corpo = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!res.ok || !corpo?.url) return fail("/login", "error");

  return redirectWithCookies(res, corpo.url);
};
