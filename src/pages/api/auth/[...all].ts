import type { APIRoute } from "astro";

import { fail, safeNext } from "~/lib/http";
import { secondFactorStep } from "~/lib/second-factor";

export const prerender = false;

/**
 * Better Auth's own routes, as seen from OUTSIDE.
 *
 * The library answers a long list of routes under `/api/auth`: sign in, sign
 * up, the whole admin plugin, the whole organization plugin, delete the
 * account. The application never sends a browser to any of them. Its forms
 * post to the application's own endpoints (`/api/login`, `/api/signup`,
 * `/api/w/<slug>/members`…), and those call the library from inside, through
 * `callAuth` or `auth.api.*`, after doing what the library does not do: the
 * Turnstile check, the role matrix, the audit trail, the confirmations.
 *
 * Left open, every one of those routes was a second door that skipped all of
 * that: impersonating a user with no audit row and without the administrator's
 * second factor, creating a workspace with any address, deleting the account
 * with no password, signing in without the robot check.
 *
 * So only what a browser has to reach by itself stays open: the links that
 * arrive by e-mail and the return from a social provider. All of them are GET.
 * Anything else does not exist.
 */
const OPEN: RegExp[] = [
  // Return from Google or GitHub.
  /^\/api\/auth\/callback\/[a-z0-9_-]+$/i,
  // The link of the confirmation e-mails (new account, change of address).
  /^\/api\/auth\/verify-email$/,
  // The link of the "reset your password" e-mail, which hands over to the page.
  /^\/api\/auth\/reset-password\/[^/]+$/,
  // Where the library sends a failed social sign-in that has nowhere else to go.
  /^\/api\/auth\/error$/,
];

/** @returns The answer for a route that is not open: it does not exist. */
function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * The e-mail address a confirmation link is about, read from its token.
 *
 * Read, not verified: the library verifies the signature when it handles the
 * link. This only decides whether to hand the link over at all, and a forged
 * token gains nothing by being refused here or there.
 *
 * @param token The `token` of the link.
 * @returns The address and whether the link is a change of address, or `null`.
 */
function linkTarget(token: string | null): { email: string; changesEmail: boolean } | null {
  const part = (token ?? "").split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { email?: unknown; updateTo?: unknown };
    if (typeof payload.email !== "string") return null;
    return { email: payload.email.toLowerCase(), changesEmail: typeof payload.updateTo === "string" };
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request, locals, url }) => {
  if (!OPEN.some((route) => route.test(url.pathname))) return notFound();

  // Confirming a new account signs the person in. With someone else already
  // signed in on this browser, that would quietly swap one account for the
  // other: a stranger creates an account, sends its link to a person who is
  // signed in, and from the click on that person is working inside the
  // stranger's account without noticing. A link that is about another
  // account is refused while this one is signed in. (A change of address is
  // left to the library, which already compares the two.)
  if (url.pathname === "/api/auth/verify-email") {
    const target = linkTarget(url.searchParams.get("token"));
    if (target && !target.changesEmail) {
      const current = await locals.auth.api.getSession({ headers: request.headers });
      if (current && current.user.email.toLowerCase() !== target.email) {
        return fail("/dashboard", "other_account");
      }
    }
  }

  const response = await locals.auth.handler(request);

  // The return from a social provider, for an account with two-step
  // verification: the library has not opened a session, only left the cookie
  // the code page finishes the sign-in with. The person goes there.
  if (url.pathname.startsWith("/api/auth/callback/")) {
    const step = await secondFactorStep(response, url.origin, (value) => safeNext(value));
    if (step) return step;
  }

  return response;
};

/** Every other method. Nothing the application needs is reached this way. */
export const ALL: APIRoute = () => notFound();
