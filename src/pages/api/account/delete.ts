import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { isLastAdminError } from "~/lib/errors";
import { getDb } from "~/lib/auth";
import { organization } from "~/db/schema";
import { workspacesWhereSoleOwner } from "~/lib/workspaces";
import { eq } from "drizzle-orm";
import { actor, denyAccount } from "~/lib/guards";
import { fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/security";

/**
 * Account deletion (LGPD, art. 18, VI).
 *
 * The audit trail is anonymized in `deleteUser.afterDelete`, in auth.ts.
 * The database trigger still holds: the last active administrator cannot
 * delete themselves, and the message explains why instead of showing a raw
 * error.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const me = actor(locals);
  const password = str(form, "password");

  // Typing your own email prevents the impulsive click — deleting cannot be undone.
  if (str(form, "confirmation").trim().toLowerCase() !== me.email.toLowerCase()) {
    return fail(PAGE, "confirm_email");
  }
  if (!password) return fail(PAGE, "fields");

  // ------------------------------------------------------------------
  // Workspaces where the person is the ONLY owner
  //
  // The `keep_one_owner_on_delete` trigger prevents removing the last owner of
  // a workspace that still exists — so deleting the account directly would be
  // refused by the database with a raw message. The rule:
  //
  //   • workspace only theirs → deletes the workspace FIRST (the cascade takes
  //                          the membership along, and then the user can leave)
  //   • workspace with more people → blocks and asks for a transfer, because
  //                          deleting would take everyone's work along
  // ------------------------------------------------------------------
  const soleOwned = await workspacesWhereSoleOwner(locals.env, me.id);
  const shared = soleOwned.filter((w) => w.memberCount > 1);

  if (shared.length > 0) {
    return fail(PAGE, "last_owner");
  }

  // Recorded BEFORE: after deleting there is no actor left to record.
  await audit(locals.env, {
    action: AUDIT.SELF_ACCOUNT_DELETED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    targetEmail: me.email,
    request,
  });

  try {
    // Order matters: deleting the user first would make the cascade try to
    // remove an owner from a workspace that still exists, and the trigger would
    // refuse.
    const db = getDb(locals.env);
    for (const ws of soleOwned) {
      await db.delete(organization).where(eq(organization.id, ws.id));
    }

    const res = await callAuth(locals.auth, request, "/delete-user", { password });
    if (!res.ok) {
      return handleAuthResponse(res, PAGE, PAGE, (c) => (c === "credentials" ? "current_password" : c));
    }
  } catch (error) {
    if (isLastAdminError(error)) return fail(PAGE, "last_admin");
    console.error("account/delete:", error);
    return fail(PAGE, "error");
  }

  return ok("/login", "ok_account_deleted");
};
