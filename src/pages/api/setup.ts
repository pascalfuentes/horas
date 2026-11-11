import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth, getDb } from "~/lib/auth";
import { user as userTable } from "~/db/schema";
import { codeFromAuthError, fail, handleAuthResponse, isEmail, str } from "~/lib/http";
import { countPlatformAdmins, userByEmail } from "~/lib/platform";
import { timingSafeEqual } from "~/lib/tokens";
import { eq } from "drizzle-orm";

export const prerender = false;

/**
 * Bootstrap of the platform superadmin.
 *
 * The condition changed along with open signup. It used to be "empty
 * database", which became a race: someone signing up first was enough to make
 * the superadmin impossible to create. Now the lock is **no active superadmin
 * exists** — which stays true until someone takes the post.
 *
 * Two locks, as before: `SETUP_SECRET` must be configured and must match.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.env;
  const form = await request.formData();

  if (!env.SETUP_SECRET) return fail("/setup", "no_permission");
  if (!(await timingSafeEqual(str(form, "secret"), env.SETUP_SECRET))) {
    return fail("/setup", "no_permission");
  }
  if ((await countPlatformAdmins(env)) > 0) return fail("/login", "no_permission");

  const name = str(form, "name");
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");

  if (!name || !isEmail(email)) return fail("/setup", "fields");
  if (password.length < 10) return fail("/setup", "password_short");
  if (password !== str(form, "confirm")) return fail("/setup", "password_mismatch");

  const db = getDb(env);
  const existing = await userByEmail(env, email);

  try {
    if (!existing) {
      // Goes through the normal signup — a single path to create a user, which
      // is also what guarantees the personal workspace through the hook.
      const res = await callAuth(locals.auth, request, "/sign-up/email", {
        name,
        email,
        password,
      });
      if (!res.ok) return handleAuthResponse(res, "/setup", "/setup");
    }

    const target = existing ?? (await userByEmail(env, email));
    if (!target) return fail("/setup", "error");

    // Promotes to superadmin and waives email verification: whoever holds the
    // SETUP_SECRET is the operator of the installation, not a visitor.
    await db
      .update(userTable)
      .set({ role: "admin", emailVerified: true })
      .where(eq(userTable.id, target.id));

    await audit(env, { action: AUDIT.SETUP_FIRST_ADMIN, targetEmail: email, request });

    // Signs in right away. Verification was just waived above, so the
    // password login goes through.
    const signIn = await callAuth(locals.auth, request, "/sign-in/email", {
      email,
      password,
    });
    return handleAuthResponse(signIn, "/dashboard", "/login");
  } catch (error) {
    console.error("setup:", error);
    return fail("/setup", codeFromAuthError(error));
  }
};
