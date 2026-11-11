import { and, eq } from "drizzle-orm";

import { member, organization, type WorkspaceRole } from "~/db/schema";
import { getDb } from "~/lib/auth";
import { isUniqueViolation } from "~/lib/errors";
import type { AppEnv } from "~/lib/env";

/**
 * Workspace = Better Auth's `organization`. The name in the product is
 * workspace; the name in the table is what the plugin expects.
 */

/** Readable slug from the name: no accents, no spaces, no messy edges. */
export function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // "Ana's workspace" -> "anas-workspace", not "ana-s-workspace".
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

/**
 * Creates a workspace and makes the person its `owner`.
 *
 * Inserts directly through Drizzle instead of calling
 * `auth.api.createOrganization` because this runs INSIDE the user creation
 * hook — calling the Better Auth API from there would be reentrant. In
 * exchange, the `organizationHooks` do not fire, so the audit entry is recorded
 * by the caller.
 *
 * `organization.slug` is UNIQUE: if the clean slug already exists, it tries
 * with a random suffix instead of blowing up.
 */
export async function createWorkspace(
  env: AppEnv,
  input: { name: string; ownerId: string },
): Promise<{ id: string; name: string; slug: string }> {
  const db = getDb(env);
  const base = makeSlug(input.name);

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${suffix()}`;
    const id = crypto.randomUUID();

    try {
      await db.insert(organization).values({
        id,
        name: input.name,
        slug,
        createdAt: new Date(),
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }

    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: id,
      userId: input.ownerId,
      role: "owner",
      createdAt: new Date(),
    });

    return { id, name: input.name, slug };
  }

  throw new Error("Could not generate a free slug for the workspace.");
}

const suffix = () => Math.random().toString(36).slice(2, 6);

export type Membership = {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
};

/** All of a person's workspaces, with their role in each one. */
export async function userWorkspaces(env: AppEnv, userId: string): Promise<Membership[]> {
  return getDb(env)
    .select({
      workspaceId: organization.id,
      workspaceName: organization.name,
      workspaceSlug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(organization.name)
    .all();
}

/**
 * A person's membership in a workspace, by slug.
 *
 * This is the function that authorizes access: `null` means "not a member", and
 * the caller must treat it as 404 — not 403. Saying "permission denied" would
 * confirm that the workspace exists, which is free information for anyone
 * probing.
 */
export async function membershipBySlug(
  env: AppEnv,
  input: { slug: string; userId: string },
): Promise<Membership | null> {
  const row = await getDb(env)
    .select({
      workspaceId: organization.id,
      workspaceName: organization.name,
      workspaceSlug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(organization.slug, input.slug), eq(member.userId, input.userId)))
    .get();

  return row ?? null;
}

/** Workspaces where the person is the ONLY owner, with the member count. */
export async function workspacesWhereSoleOwner(
  env: AppEnv,
  userId: string,
): Promise<Array<{ id: string; name: string; memberCount: number }>> {
  const rows = await env.DB.prepare(
    `SELECT o."id", o."name" AS name,
            (SELECT COUNT(*) FROM "member" WHERE "organizationId" = o."id") AS "memberCount"
       FROM "member" m
       JOIN "organization" o ON o."id" = m."organizationId"
      WHERE m."userId" = ?1
        AND m."role" = 'owner'
        AND (SELECT COUNT(*) FROM "member"
              WHERE "organizationId" = o."id" AND "role" = 'owner') = 1`,
  )
    .bind(userId)
    .all<{ id: string; name: string; memberCount: number }>();

  return rows.results ?? [];
}
