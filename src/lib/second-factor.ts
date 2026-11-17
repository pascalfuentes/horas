/**
 * The second factor after a sign-in that did not go through the password.
 *
 * Better Auth's two-factor plugin only asks for the code after a password
 * sign-in. Coming back from Google or GitHub, the session was opened on the
 * spot: an account with two-step verification on, and a social login linked,
 * could be entered without the code by anyone who got into that social
 * account. For an administrator, whose second factor is mandatory here, the
 * mandatory part could be walked around.
 *
 * The plugin already has the step that is needed: it takes the session that
 * was just opened, throws it away, and leaves the short-lived cookie that the
 * code page (`/two-factor`) finishes the sign-in with. This file only makes
 * that same step run after a social sign-in too, and turns the library's
 * answer into a trip to the code page. Nothing of the plugin is copied.
 *
 * No imports, on purpose: `scripts/social-2fa-check.mjs` loads this file in
 * Node to exercise it against the real library.
 */

/** One "after" step of a Better Auth plugin: when it runs and what it does. */
type AfterStep = {
  matcher: (context: { path?: string }) => boolean;
  handler: unknown;
};

/** The part of a plugin this file looks at. */
type WithAfterSteps = { hooks?: { after?: AfterStep[] } };

/**
 * Whether a route of the library is one where a social provider's answer can
 * open a session: the return from the provider, and the sign-in route itself
 * (which opens one directly when it is handed an identity token).
 *
 * @param path The route, as the library names it (`/callback/:id`).
 * @returns `true` for a social sign-in route.
 */
export function isSocialSignIn(path: string): boolean {
  return path === "/sign-in/social" || path === "/callback/:id" || path.startsWith("/callback/");
}

/**
 * Makes the two-factor plugin ask for the code after a social sign-in too.
 *
 * It widens WHEN the plugin's own step runs and leaves WHAT it does alone.
 * The step is recognised by what it answers for a password sign-in. If a
 * future version of the library moves it, this throws when the app starts:
 * better a site that says why it will not start than one that quietly stopped
 * asking for the second factor.
 *
 * @param plugin What `twoFactor()` returned.
 * @returns The same plugin, changed in place.
 */
export function askAfterSocialSignIn<T extends object>(plugin: T): T {
  // Looked at through a loose shape, and handed back as exactly what came in:
  // the plugin's own type is what tells the rest of the app which routes and
  // fields exist, and it must come out of here untouched.
  const step = (plugin as WithAfterSteps).hooks?.after?.find((candidate) => {
    try {
      return typeof candidate?.matcher === "function" && candidate.matcher({ path: "/sign-in/email" }) === true;
    } catch {
      return false;
    }
  });
  if (!step) {
    throw new Error(
      "The two-factor plugin no longer has the step that runs after a password sign-in. " +
        "src/lib/second-factor.ts has to be looked at again before this version of better-auth is used.",
    );
  }

  const afterPassword = step.matcher;
  step.matcher = (context) => afterPassword(context) || isSocialSignIn(context.path ?? "");
  return plugin;
}

/**
 * What to answer when the library's answer to the return from a social
 * provider says "the second factor is pending".
 *
 * After a password sign-in the library says so in JSON, and the endpoint that
 * asked reads it. After the return from a provider nobody reads JSON: it is a
 * browser arriving, and the answer still carries the redirect to the page the
 * person was going to, where nobody is signed in yet. So the person goes to
 * the code page instead, with the cookies the library set and the page they
 * wanted kept for afterwards.
 *
 * @param response The library's answer.
 * @param origin The site's own origin, to tell a page of the site from another site.
 * @param safePath Turns what came in the redirect into a path that can be trusted.
 * @returns The redirect to the code page, or `null` when the answer needs nothing.
 */
export async function secondFactorStep(
  response: Response,
  origin: string,
  safePath: (value: string) => string,
): Promise<Response | null> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { twoFactorRedirect?: unknown } | null;
  if (body?.twoFactorRedirect !== true) return null;

  let wanted = "";
  try {
    const to = new URL(response.headers.get("location") ?? "", origin);
    if (to.origin === origin) wanted = to.pathname + to.search;
  } catch {
    /* an odd address: the code page falls back to the dashboard */
  }

  const headers = new Headers({
    Location: `/two-factor?next=${encodeURIComponent(safePath(wanted))}`,
    "Cache-Control": "no-store",
  });
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
