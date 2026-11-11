import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { socialProviders } from "~/lib/env";
import { fail, redirectWithCookies, safeNext, str } from "~/lib/http";

export const prerender = false;

/**
 * Starts the OAuth flow. Better Auth returns the provider URL and the
 * `state`/PKCE cookies — the two must travel together, otherwise the callback
 * is rejected for not recognizing the request that originated it.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const provider = str(form, "provider");
  const next = safeNext(str(form, "next"));

  // The list comes from the configured keys: a provider without credentials is
  // not accepted even if someone forges the form.
  if (!socialProviders(locals.env).includes(provider as "google" | "github")) {
    return fail("/login", "social_unavailable");
  }

  const res = await callAuth(locals.auth, request, "/sign-in/social", {
    provider,
    callbackURL: next,
    newUserCallbackURL: next,
    // Where the provider sends the person back when something goes wrong —
    // disabled account, email already linked to another method, authorization
    // denied. Better Auth appends `?error=<code>` here; the message is generic
    // on purpose, because the raw code means nothing to whoever is on screen.
    errorCallbackURL: "/login?e=social_failed",
  });

  const body = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!res.ok || !body?.url) return fail("/login", "error");

  return redirectWithCookies(res, body.url);
};
