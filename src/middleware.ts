import type { APIContext, MiddlewareNext } from "astro";
import { defineMiddleware } from "astro:middleware";

import { REQUIRE_2FA_FOR_ADMINS } from "~/config";
import { elsewhere, overPlainHttp, servedOverHttps } from "~/lib/address";
import { createAuth } from "~/lib/auth";
import { env } from "~/lib/env";
import { canAdministerPlatform } from "~/lib/permissions";
import { membershipBySlug } from "~/lib/workspaces";

/** Routes reachable without a session. Anything not listed here requires login. */
const PUBLIC_PAGES = new Set([
  "/",
  "/login",
  "/signup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/setup",
  // You get here with the password accepted but no session yet — only the
  // temporary second-factor cookie. There is no session to require.
  "/two-factor",
  // Public: Google requires the policy URL to publish the OAuth app.
  "/privacy",
  // The "not found" screen itself: an address that does not exist is rewritten
  // to it, with or without a session.
  "/404",
]);

/** API endpoints reachable without a session — they are precisely the ones that create one. */
const PUBLIC_API = new Set([
  "/api/login",
  "/api/logout",
  "/api/signup",
  "/api/resend-verification",
  "/api/forgot-password",
  "/api/reset-password",
  "/api/setup",
  "/api/two-factor",
  "/api/social",
]);

/** Pages an ALREADY signed-in user should not see. */
const ANONYMOUS_ONLY = new Set([
  "/login",
  "/signup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/setup",
  "/two-factor",
]);

/**
 * Something like `/favicon.ico` or `/robots.txt`: a request for a file, not a
 * route. When the file does not exist, the assets handler does not serve it and
 * the request lands here — without a session, it would become a 302 to the
 * login. It should be a 404.
 */
const LOOKS_LIKE_FILE = /\.[a-z0-9]{1,8}$/i;

/** `/w/<slug>/…` and `/api/w/<slug>/…` — the slug is what authorizes. */
const WORKSPACE_ROUTE = /^\/(?:api\/)?w\/([^/]+)/;

/** Methods that only read. Every other one changes something. */
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Headers every answer of the Worker carries, whatever the page.
 *
 * The content policy here is the part that cannot break a page: who may frame
 * the site (nobody: a framed dashboard is how a click meant for another page
 * presses "Delete" here), where `<base>` may point and no plugins. A policy
 * for scripts is a separate piece of work, because the pages use inline
 * scripts and, with analytics on, Tag Manager loads whatever its container
 * says.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** One year. Without `includeSubDomains`: the site answers for its own host only. */
const HSTS = "max-age=31536000";

/**
 * Token API and MCP server: authentication is the personal token, checked
 * inside the handler itself (`authenticateToken`). There is no cookie or
 * session there.
 *
 * @param path The path of the request.
 * @returns `true` for a route that is called by programs, with a token.
 */
function isTokenRoute(path: string): boolean {
  return path.startsWith("/api/v1/") || path === "/mcp" || path.startsWith("/mcp/");
}

/**
 * The outer layer: what is decided before any page or session is looked at,
 * and what is added to every answer on the way out.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const tokenRoute = isTokenRoute(path);

  const response = await before(context, tokenRoute) ?? (await gate(context, next));
  return withSecurityHeaders(response, context);
});

/**
 * Refusals that depend only on how the request arrived.
 *
 * @param context The request.
 * @param tokenRoute Whether it is a route called with a personal token.
 * @returns The answer, or `null` to carry on.
 */
async function before(context: APIContext, tokenRoute: boolean): Promise<Response | null> {
  // Plain HTTP at a site that has HTTPS. A page goes to the same address over
  // HTTPS. A token route is refused instead: a program that POSTs does not
  // follow a redirect, and answering would teach it that sending the token in
  // the clear works.
  if (overPlainHttp(context.url, context.request.headers, env.BETTER_AUTH_URL)) {
    if (tokenRoute) {
      return new Response(JSON.stringify({ error: "Use HTTPS." }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const secure = new URL(context.url);
    secure.protocol = "https:";
    return new Response(null, {
      status: 308,
      headers: { Location: secure.toString(), "Cache-Control": "no-store" },
    });
  }

  // A request that changes something has to come from a page of this site.
  // The browser says where a request was made from in `Origin`, and a page of
  // another site cannot forge it.
  //
  // This replaces Astro's own check (`security.checkOrigin`), which is off in
  // astro.config.mjs for one reason: it runs before any of this code, on every
  // route, and it refuses a DELETE or a POST that has no `Content-Type`. That
  // is exactly what a program sends to the token API, where there is no cookie
  // to protect and no `Origin` to send. Here the token routes are left out and
  // every other route is checked whatever its content type, which is stricter
  // than what it replaces.
  if (!tokenRoute && !READ_ONLY.has(context.request.method)) {
    if (context.request.headers.get("origin") !== context.url.origin) {
      return new Response("Cross-site requests are forbidden", { status: 403 });
    }
  }

  return null;
}

/**
 * Adds the security headers to an answer.
 *
 * @param response The answer about to leave.
 * @param context The request it answers.
 * @returns The same answer with the headers, or a copy when its headers are locked.
 */
function withSecurityHeaders(response: Response, context: APIContext): Response {
  let out = response;
  try {
    out.headers.set("X-Content-Type-Options", SECURITY_HEADERS["X-Content-Type-Options"]);
  } catch {
    // An answer handed over from `fetch` has locked headers.
    out = new Response(response.body, response);
  }

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name) || name === "X-Content-Type-Options") out.headers.set(name, value);
  }
  if (servedOverHttps(context.url, env.BETTER_AUTH_URL)) {
    out.headers.set("Strict-Transport-Security", HSTS);
  }

  // A page drawn for a signed-in person holds their data: it must not stay in
  // a shared cache, nor come back from the browser's own after they sign out.
  const html = (out.headers.get("content-type") ?? "").includes("text/html");
  if (html && context.locals.user && !out.headers.has("cache-control")) {
    out.headers.set("Cache-Control", "no-store");
  }
  return out;
}

/**
 * The gate: one address, who is signed in, which workspace, which role.
 *
 * @param context The request.
 * @param next Hands the request to the page or endpoint.
 * @returns The answer.
 */
async function gate(context: APIContext, next: MiddlewareNext): Promise<Response> {
  context.locals.env = env;
  context.locals.auth = createAuth(env);
  context.locals.membership = null;

  const path = context.url.pathname;

  // Going through the session gate below would only yield a redirect to the
  // login for a route that has no cookie at all.
  const tokenRoute = isTokenRoute(path);

  // One address. A request that arrived at another one (the `*.workers.dev`
  // address next to a custom domain, a domain the site used to have) goes to
  // the same page at the site's address, the only place where the session
  // cookie and the origin check work.
  //
  // The token routes are the exception and answer wherever they are called:
  // nothing in them depends on the address, and a client that POSTs does not
  // follow a redirect — a connector set up with the previous address would
  // just stop working.
  //
  // Temporary and never cached, on purpose. The direction follows a secret:
  // while a new domain is attached but `BETTER_AUTH_URL` still holds the old
  // address, the NEW domain is the one sent away. A permanent redirect from
  // that moment would stay in the browser and become a loop the day the
  // secret changes.
  if (!tokenRoute) {
    const target = elsewhere(context.url, env.BETTER_AUTH_URL);
    if (target) {
      return new Response(null, {
        status: 307,
        headers: { Location: target, "Cache-Control": "no-store" },
      });
    }
  }

  // Better Auth's own routes. Only a handful is reachable from outside, and
  // the route file is what decides which (`src/pages/api/auth/[...all].ts`).
  if (path.startsWith("/api/auth/")) return next();

  if (tokenRoute) return next();

  const isApi = path.startsWith("/api/");
  const protectedArea =
    path.startsWith("/dashboard") ||
    path.startsWith("/w/") ||
    path.startsWith("/workspaces") ||
    isApi;

  // Before resolving the session: a file request does not spend a database
  // query or go through the authentication gate.
  if (!protectedArea && LOOKS_LIKE_FILE.test(path)) return next();

  const payload = await context.locals.auth.api.getSession({ headers: context.request.headers });
  context.locals.user = (payload?.user as App.Locals["user"]) ?? null;
  context.locals.session = payload?.session ?? null;

  // The invite page is public: someone who has no account yet needs to reach
  // it to understand what it is and create the account with the right email.
  // ACCEPTING, on the other hand, does require a session — and the plugin
  // still checks that the email matches.
  const invitePage = !isApi && path.startsWith("/invite/");
  const needsSession = invitePage
    ? false
    : isApi
      ? !PUBLIC_API.has(path)
      : !PUBLIC_PAGES.has(path);

  if (needsSession && !context.locals.user) {
    if (isApi) return new Response("Not authenticated", { status: 401 });
    // Outside the protected areas, a page that is not public does not exist.
    // Asking for a login there would only postpone the "not found": the person
    // would sign in and then learn the address was wrong. It is a rewrite and
    // not `next()` on purpose: if a page is ever added outside those areas and
    // left off the public list, it shows "not found" instead of opening to
    // everyone.
    if (!protectedArea) return context.rewrite("/404");
    return context.redirect(`/login?next=${encodeURIComponent(path + context.url.search)}`);
  }

  // ------------------------------------------------------------------
  // Workspace in the URL
  //
  // The slug is the source of truth for authorization, not
  // `session.activeOrganizationId`: that one is a single value per session,
  // and with two tabs open on different workspaces the second would switch the
  // first one's active workspace — which would still look correct on screen
  // while acting on the wrong workspace.
  // ------------------------------------------------------------------
  const workspaceMatch = path.match(WORKSPACE_ROUTE);
  if (workspaceMatch && context.locals.user) {
    const slug = decodeURIComponent(workspaceMatch[1]);
    const membership = await membershipBySlug(env, { slug, userId: context.locals.user.id });

    // 404 and not 403, on purpose: "permission denied" would confirm that the
    // workspace exists, which is free information for anyone probing slugs.
    if (!membership) {
      if (isApi) return new Response("Workspace not found", { status: 404 });
      return context.rewrite("/404");
    }

    context.locals.membership = membership;

    // Remembers the last workspace used, so /dashboard knows where to send
    // the person later. Only writes when it changed.
    if (context.locals.session?.activeOrganizationId !== membership.workspaceId) {
      await env.DB.prepare(`UPDATE "session" SET "activeOrganizationId" = ?1 WHERE "id" = ?2`)
        .bind(membership.workspaceId, context.locals.session!.id)
        .run()
        .catch((err) => console.error("sync active workspace:", err));
    }
  }

  // PLATFORM administration area — not that of anyone's application.
  if (path.startsWith("/dashboard/admin") || path.startsWith("/api/admin")) {
    if (!canAdministerPlatform(context.locals.user?.role)) {
      if (isApi) return new Response("Permission denied", { status: 403 });
      return context.redirect("/dashboard?e=no_permission");
    }
  }

  // Platform administrator without 2FA: they get in, but can only navigate to
  // the setup screen. It blocks navigation, not access.
  if (REQUIRE_2FA_FOR_ADMINS && canAdministerPlatform(context.locals.user?.role)) {
    const allowed =
      path === "/dashboard/security/2fa" || path === "/api/security/2fa" || path === "/api/logout";

    if (!context.locals.user?.twoFactorEnabled && !allowed) {
      if (isApi) return new Response("Enable two-step verification", { status: 403 });
      return context.redirect("/dashboard/security/2fa?required=1");
    }
  }

  // Someone already signed in has no business on the login or signup pages.
  if (context.locals.user && ANONYMOUS_ONLY.has(path)) {
    return context.redirect("/dashboard");
  }

  return next();
}
