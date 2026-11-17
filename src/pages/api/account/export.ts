import { desc, eq, or } from "drizzle-orm";
import type { APIRoute } from "astro";

import { account, auditLog, note, session, user as userTable } from "~/db/schema";
import { getDb } from "~/lib/auth";
import { userWorkspaces } from "~/lib/workspaces";
import { actor, denyAccount } from "~/lib/guards";

export const prerender = false;

/**
 * Personal data export (LGPD, art. 18, II).
 *
 * What does NOT go along: password hash, 2FA secret, recovery codes and
 * social provider tokens. They are credentials, not information about the
 * person — handing them over in a file only creates a new way to leak the
 * account.
 */
export const GET: APIRoute = async ({ locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const me = actor(locals);
  const db = getDb(locals.env);

  const [accountData] = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      phone: userTable.phone,
      role: userTable.role,
      emailVerified: userTable.emailVerified,
      twoFactorEnabled: userTable.twoFactorEnabled,
      createdAt: userTable.createdAt,
      updatedAt: userTable.updatedAt,
    })
    .from(userTable)
    .where(eq(userTable.id, me.id));

  const sessions = await db
    .select({
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ip: session.ipAddress,
      browser: session.userAgent,
    })
    .from(session)
    .where(eq(session.userId, me.id))
    .orderBy(desc(session.createdAt));

  const loginMethods = await db
    .select({ provider: account.providerId, linkedAt: account.createdAt })
    .from(account)
    .where(eq(account.userId, me.id));

  // The IP of a row belongs to whoever performed the action. When the person
  // was only the TARGET (an administrator disabled them, an owner changed
  // their role), that IP is somebody else's personal data, and this file is
  // about the person who asked for it. Same rule as when an account is
  // deleted (`deleteUser.afterDelete`, in auth.ts): the IP is theirs when
  // they are the actor, or when the row has no actor at all.
  const actions = (
    await db
      .select({
        when: auditLog.createdAt,
        action: auditLog.action,
        target: auditLog.targetEmail,
        details: auditLog.details,
        ip: auditLog.ip,
        actorId: auditLog.actorId,
        actorEmail: auditLog.actorEmail,
      })
      .from(auditLog)
      .where(or(eq(auditLog.actorId, me.id), eq(auditLog.targetId, me.id)))
      .orderBy(desc(auditLog.createdAt))
  ).map(({ actorId, actorEmail, ip, ...row }) => ({
    ...row,
    ip: actorId === me.id || (actorId === null && actorEmail === null) ? ip : null,
  }));

  // Memberships: which workspaces the person is part of and with what role.
  const memberships = (await userWorkspaces(locals.env, me.id)).map((w) => ({
    workspace: w.workspaceName,
    role: w.role,
  }));

  const notes = await db
    .select({ title: note.title, content: note.body, createdAt: note.createdAt })
    .from(note)
    .where(eq(note.authorId, me.id));

  // Tracked hours, across all workspaces. Projects belong to the workspace, not
  // the person — so they go in only as a name on each entry.
  const timeEntries =
    (
      await locals.env.DB.prepare(
        `SELECT o."name" AS workspace, e."description" AS description, p."name" AS project,
                e."tags", e."billable" AS billable, e."start" AS "start", e."end" AS "end"
           FROM "time_entry" e
           JOIN "organization" o ON o."id" = e."workspaceId"
           LEFT JOIN "time_project" p ON p."id" = e."projectId"
          WHERE e."userId" = ?1 ORDER BY e."start"`,
      )
        .bind(me.id)
        .all()
    ).results ?? [];

  const content = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note:
        "Password, 2FA secret, recovery codes and social provider tokens " +
        "are not exported: they are access credentials, not data about you.",
      account: accountData,
      memberships,
      loginMethods,
      sessions,
      actions,
      notes,
      timeEntries,
    },
    null,
    2,
  );

  return new Response(content, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="my-data-${me.email}.json"`,
      "cache-control": "no-store",
    },
  });
};
