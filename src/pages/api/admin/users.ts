import type { APIRoute } from "astro";

import { eq } from "drizzle-orm";

import { PLATFORM_ROLES, twoFactor, user as userTable, type PlatformRole } from "~/db/schema";
import { AUDIT, audit } from "~/lib/audit";
import { getDb } from "~/lib/auth";
import { actor, denyPlatform, isLastAdminError } from "~/lib/guards";
import { codeFromAuthError, fail, ok, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/admin/users";

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyPlatform(locals);
  if (denied) return denied;

  const form = await request.formData();
  const action = str(form, "action");
  const userId = str(form, "userId");
  const targetEmail = str(form, "email") || null;
  const me = actor(locals);
  const headers = request.headers;

  if (!userId) return fail(PAGE, "fields");

  const record = (action: (typeof AUDIT)[keyof typeof AUDIT], details?: Record<string, unknown>) =>
    audit(locals.env, {
      action,
      actorId: me.id,
      actorEmail: me.email,
      targetId: userId,
      targetEmail,
      details,
      request,
    });

  try {
    switch (action) {
      case "role": {
        const role = str(form, "role") as PlatformRole;
        if (!(PLATFORM_ROLES as readonly string[]).includes(role)) return fail(PAGE, "fields");
        // Even as an admin: changing your own role is always a workplace
        // accident waiting to happen.
        if (userId === me.id) return fail(PAGE, "own_role");

        await locals.auth.api.setRole({ body: { userId, role }, headers });
        await record(AUDIT.USER_ROLE_CHANGED, { newRole: role });
        return ok(PAGE, "ok_role");
      }

      case "disable": {
        if (userId === me.id) return fail(PAGE, "own_status");
        await locals.auth.api.banUser({
          body: { userId, banReason: str(form, "reason") || "Disabled by an administrator" },
          headers,
        });
        await record(AUDIT.USER_DISABLED);
        return ok(PAGE, "ok_disabled");
      }

      case "enable": {
        await locals.auth.api.unbanUser({ body: { userId }, headers });
        await record(AUDIT.USER_ENABLED);
        return ok(PAGE, "ok_enabled");
      }

      case "reset-2fa": {
        // Without this, whoever loses the phone AND the recovery codes stays
        // locked out forever — not even the admin could help, only by editing
        // the database by hand. Removing the second factor restores access by
        // password.
        const db = getDb(locals.env);
        const removed = await db.delete(twoFactor).where(eq(twoFactor.userId, userId)).returning({ id: twoFactor.id });
        if (removed.length === 0) return fail(PAGE, "no_2fa");

        await db.update(userTable).set({ twoFactorEnabled: false }).where(eq(userTable.id, userId));
        // This person's open sessions were created with the second factor
        // that just ceased to exist: dropping them is the least we can do.
        await locals.auth.api.revokeUserSessions({ body: { userId }, headers });

        await record(AUDIT.USER_2FA_RESET);
        return ok(PAGE, "ok_2fa_reset");
      }

      case "revoke-sessions": {
        await locals.auth.api.revokeUserSessions({ body: { userId }, headers });
        await record(AUDIT.USER_SESSIONS_REVOKED);
        return ok(PAGE, "ok_sessions");
      }

      default:
        return fail(PAGE, "fields");
    }
  } catch (error) {
    // The database trigger aborted: it was the last active administrator.
    if (isLastAdminError(error)) return fail(PAGE, "last_admin");
    console.error("admin/users:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
