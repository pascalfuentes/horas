import { defineMiddleware } from "astro:middleware";

import { REQUIRE_2FA_FOR_ADMINS } from "~/config";
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

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.env = env;
  context.locals.auth = createAuth(env);
  context.locals.membership = null;

  const path = context.url.pathname;

  // Better Auth's own routes handle their own authorization.
  if (path.startsWith("/api/auth/")) return next();

  // Token API and MCP server: authentication is the personal token, checked
  // inside the handler itself (`authenticateToken`). There is no cookie or
  // session here — going through the gate below would only yield a redirect to
  // the login.
  if (path.startsWith("/api/v1/") || path === "/mcp" || path.startsWith("/mcp/")) return next();

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
});
