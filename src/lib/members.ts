import { and, desc, eq, gt, sql } from "drizzle-orm";

import {
  member,
  organization,
  orgInvitation,
  user as userTable,
  type WorkspaceRole,
} from "~/db/schema";
import { getDb } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";

/** Members of a workspace, with the person's details. */
export type WorkspaceMember = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  since: Date;
};

export async function listMembers(env: AppEnv, workspaceId: string): Promise<WorkspaceMember[]> {
  return getDb(env)
    .select({
      memberId: member.id,
      userId: member.userId,
      name: userTable.name,
      email: userTable.email,
      role: member.role,
      since: member.createdAt,
    })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(eq(member.organizationId, workspaceId))
    .orderBy(member.createdAt)
    .all();
}

export type WorkspaceInvite = {
  id: string;
  email: string;
  role: WorkspaceRole | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: string | null;
};

export async function listInvites(env: AppEnv, workspaceId: string): Promise<WorkspaceInvite[]> {
  return getDb(env)
    .select({
      id: orgInvitation.id,
      email: orgInvitation.email,
      role: orgInvitation.role,
      status: orgInvitation.status,
      expiresAt: orgInvitation.expiresAt,
      createdAt: orgInvitation.createdAt,
      invitedBy: userTable.email,
    })
    .from(orgInvitation)
    .leftJoin(userTable, eq(userTable.id, orgInvitation.inviterId))
    .where(eq(orgInvitation.organizationId, workspaceId))
    .orderBy(desc(orgInvitation.createdAt))
    .limit(100)
    .all();
}

/** A pending and still valid invite is neither "expired" nor "canceled". */
export function isPending(c: WorkspaceInvite): boolean {
  return c.status === "pending" && c.expiresAt.getTime() > Date.now();
}

export function inviteStatus(c: WorkspaceInvite): string {
  if (c.status === "accepted") return "accepted";
  if (c.status === "rejected") return "declined";
  if (c.status === "canceled") return "canceled";
  return c.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

/**
 * Transfers ownership of the workspace.
 *
 * The ORDER matters: it promotes the new person first (the workspace has two
 * owners for an instant) and only then demotes whoever transferred. In the
 * reverse order, the `keep_one_owner_on_update` trigger would abort — and it
 * would be right, because the workspace would be left without an owner halfway
 * through.
 *
 * Whoever transfers becomes `admin`: they can keep working and lose only what
 * is exclusive to the owner (deleting the workspace and transferring again).
 */
export async function transferOwnership(
  env: AppEnv,
  input: { workspaceId: string; fromMemberId: string; toMemberId: string },
): Promise<void> {
  const db = getDb(env);

  await db
    .update(member)
    .set({ role: "owner" })
    .where(and(eq(member.id, input.toMemberId), eq(member.organizationId, input.workspaceId)));

  await db
    .update(member)
    .set({ role: "admin" })
    .where(and(eq(member.id, input.fromMemberId), eq(member.organizationId, input.workspaceId)));
}

/** How many active owners the workspace has. Used for messages, not as a guarantee. */
export async function countOwners(env: AppEnv, workspaceId: string): Promise<number> {
  const row = await getDb(env)
    .select({ n: sql<number>`count(*)` })
    .from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.role, "owner")))
    .get();
  return Number(row?.n ?? 0);
}

/** The membership of a specific person inside the workspace. */
export async function memberById(env: AppEnv, workspaceId: string, memberId: string) {
  return getDb(env)
    .select({
      memberId: member.id,
      userId: member.userId,
      role: member.role,
      email: userTable.email,
      name: userTable.name,
    })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(and(eq(member.id, memberId), eq(member.organizationId, workspaceId)))
    .get();
}

/** Is there already a pending invite for this email in this workspace? */
export async function hasPendingInvite(
  env: AppEnv,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const row = await getDb(env)
    .select({ id: orgInvitation.id })
    .from(orgInvitation)
    .where(
      and(
        eq(orgInvitation.organizationId, workspaceId),
        eq(orgInvitation.email, email.trim().toLowerCase()),
        eq(orgInvitation.status, "pending"),
      ),
    )
    .get();
  return Boolean(row);
}

/** Is this person already a member of this workspace? */
export async function isAlreadyMember(env: AppEnv, workspaceId: string, email: string): Promise<boolean> {
  const row = await getDb(env)
    .select({ id: member.id })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(and(eq(member.organizationId, workspaceId), eq(userTable.email, email.trim().toLowerCase())))
    .get();
  return Boolean(row);
}

/** An invite waiting for a person, seen from the invitee's side. */
export type PendingInvite = {
  id: string;
  workspaceName: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  expiresAt: Date;
};

/**
 * Valid invites addressed to this email, in any workspace.
 *
 * It exists for people who are already signed in: without it the only way to an
 * invite is the link in the email, and whoever deleted the message is stuck.
 *
 * It matches by email, not by user, because the email is what the invite
 * addresses — the same key the plugin checks at acceptance time. Here it only
 * decides what shows up on screen; what authorizes the acceptance is still the
 * plugin.
 *
 * The cap of 20 is anti-abuse: creating a workspace is free, so someone could
 * open dozens and invite the same person from each one to clutter their screen.
 */
export async function pendingInvitesFor(
  env: AppEnv,
  email: string,
): Promise<PendingInvite[]> {
  const rows = await getDb(env)
    .select({
      id: orgInvitation.id,
      workspaceName: organization.name,
      role: orgInvitation.role,
      invitedBy: userTable.email,
      expiresAt: orgInvitation.expiresAt,
    })
    .from(orgInvitation)
    .innerJoin(organization, eq(organization.id, orgInvitation.organizationId))
    .leftJoin(userTable, eq(userTable.id, orgInvitation.inviterId))
    .where(
      and(
        eq(orgInvitation.email, email.trim().toLowerCase()),
        eq(orgInvitation.status, "pending"),
        gt(orgInvitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(orgInvitation.createdAt))
    .limit(20)
    .all();

  // `role` is nullable in the plugin's runtime; an invite with no role falls back to the lowest.
  return rows.map((l) => ({ ...l, role: l.role ?? "viewer" }));
}
