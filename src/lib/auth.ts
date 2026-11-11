import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { admin as adminPlugin } from "better-auth/plugins/admin";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { organization as organizationPlugin } from "better-auth/plugins/organization";
import {
  adminAc as adminAcWorkspace,
  defaultStatements as defaultStatementsWorkspace,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/d1";

import { APP_NAME, INVITE_TTL_DAYS } from "~/config";
import { schema } from "~/db/schema";
import { assertEnv, socialProviders, type AppEnv } from "~/lib/env";
import { emailLayout, sendEmail } from "~/lib/email";
import { verifyTurnstile } from "~/lib/http";
import { createWorkspace } from "~/lib/workspaces";

/**
 * Two role lists registered with Better Auth, for two different plugins. The
 * matrix in `src/lib/permissions.ts` remains the source of truth for the
 * APPLICATION'S ROUTES; what lives here governs Better Auth's own routes. Keep
 * the two aligned.
 */

// --- PLATFORM (admin plugin): who is the installation's superadmin ---
const statements = { ...defaultStatements, content: ["read", "write"] } as const;
const ac = createAccessControl(statements);

const roles = {
  admin: ac.newRole({ ...adminAc.statements, content: ["read", "write"] }),
  user: ac.newRole({ content: ["read", "write"] }),
};

// --- WORKSPACE (organization plugin): who can do what inside a workspace ---
//
// Watch out for a plugin trap: passing `roles` REPLACES the defaults, it does
// not merge (`has-permission.mjs` does `{ ...options.roles || defaultRoles }`).
// That is why `owner` and `admin` are redeclared here from `ownerAc`/`adminAc`
// instead of inherited.
//
// The plugin's role NAME validation, on the other hand, merges the defaults
// with ours — so "member" would still be an accepted name, creating a role with
// zero permissions. That is why role validation happens in our matrix, before
// calling the plugin.
const statementsWorkspace = {
  ...defaultStatementsWorkspace,
  content: ["read", "write"],
} as const;
const acWorkspace = createAccessControl(statementsWorkspace);

const workspaceRoles = {
  owner: acWorkspace.newRole({ ...ownerAc.statements, content: ["read", "write"] }),
  admin: acWorkspace.newRole({ ...adminAcWorkspace.statements, content: ["read", "write"] }),
  editor: acWorkspace.newRole({ content: ["read", "write"] }),
  viewer: acWorkspace.newRole({ content: ["read"] }),
};

export function getDb(env: AppEnv) {
  return drizzle(env.DB, { schema });
}

export type Auth = ReturnType<typeof build>;

// One instance per isolate. `betterAuth()` builds routes and plugins; redoing
// that on every request is pure waste.
const cache = new WeakMap<object, Auth>();

export function createAuth(env: AppEnv): Auth {
  const cached = cache.get(env as unknown as object);
  if (cached) return cached;
  const auth = build(env);
  cache.set(env as unknown as object, auth);
  return auth;
}

function build(env: AppEnv) {
  assertEnv(env);
  const db = getDb(env);
  const secure = env.BETTER_AUTH_URL.startsWith("https://");

  return betterAuth({
    appName: APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],

    database: drizzleAdapter(db, { provider: "sqlite", schema }),

    // ------------------------------------------------------------------
    // Social login
    //
    // Each provider only exists when its key pair is configured — without
    // the keys, the buttons disappear and the route refuses. Same principle
    // as Turnstile: nothing half enabled.
    //
    // Signing in with Google creates the account on the spot, with the email
    // already verified by the provider — and the personal workspace comes
    // along, because the hook that creates it runs on every signup path.
    // ------------------------------------------------------------------
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },

    account: {
      accountLinking: {
        // Someone who was invited, set a password, and later signs in with
        // Google using the SAME email: without this, it would be an error
        // instead of a sign-in.
        enabled: true,
        // "Trusted" here means: the provider confirms the email before
        // telling us. Google and GitHub do. Linking by email without that
        // guarantee would let someone claim another person's account.
        trustedProviders: socialProviders(env),
      },
    },

    // ------------------------------------------------------------------
    // Password
    // ------------------------------------------------------------------
    emailAndPassword: {
      enabled: true,
      // OPEN signup: anyone can create an account. What stops someone else's
      // address from being used is no longer the invite; it is now the
      // mandatory email verification, right below.
      disableSignUp: false,
      autoSignIn: true,
      minPasswordLength: 10,
      maxPasswordLength: 200,
      // Non-negotiable with open signup: without this, anyone could create an
      // account with another person's email and get access in their name.
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 60, // 1h
      // Resetting the password kills every session: if someone got into the
      // account, the reset kicks that person out. That is the point of it.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const { html, text } = emailLayout(
          "Reset your password",
          [
            `Hi, ${escapeHtml(user.name)}.`,
            "We received a request to reset your account password. The link is valid for 1 hour and can only be used once.",
            "If this wasn't you, ignore this email — nothing changes.",
          ],
          { label: "Reset password", url },
        );
        await sendEmail(env, { to: user.email, subject: "Reset your password", html, text });
      },
    },

    // ------------------------------------------------------------------
    // Email verification (used when CHANGING the email, not at signup)
    // ------------------------------------------------------------------
    emailVerification: {
      // With open signup, the verification email is the first real step of
      // the flow, not an extra.
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        const { html, text } = emailLayout(
          "Confirm your email",
          [`Hi, ${escapeHtml(user.name)}.`, "Confirm this address to complete the change. The link is valid for 1 hour."],
          { label: "Confirm email", url },
        );
        await sendEmail(env, { to: user.email, subject: "Confirm your email", html, text });
      },
    },

    user: {
      additionalFields: {
        phone: { type: "string", required: false, input: true },
      },
      deleteUser: {
        enabled: true,
        // Runs AFTER the deletion succeeds. If it ran before and the
        // last-admin trigger aborted, the trail would be anonymized with the
        // account still standing — the worst of both worlds.
        afterDelete: async (deleted) => {
          // The privacy policy promises to keep the audit trail "in a
          // dissociated form": the action and the time remain, who did it
          // does not.
          await env.DB.prepare(
            `UPDATE "audit_log"
                SET "actorEmail" = '[account removed]', "actorId" = NULL, "ip" = NULL
              WHERE "actorId" = ?1 OR "actorEmail" = ?2`,
          )
            .bind(deleted.id, deleted.email)
            .run();
          // When the deleted person is the TARGET, the IP usually belongs to
          // whoever performed the action — and that person is still
          // identifiable, so it stays. The exception is the row with no
          // recorded actor (accepting one's own invite, for example): there
          // the IP is theirs, and it goes away with them.
          await env.DB.prepare(
            `UPDATE "audit_log"
                SET "targetEmail" = '[account removed]',
                    "targetId" = NULL,
                    "ip" = CASE WHEN "actorId" IS NULL AND "actorEmail" IS NULL
                                THEN NULL ELSE "ip" END
              WHERE "targetId" = ?1 OR "targetEmail" = ?2`,
          )
            .bind(deleted.id, deleted.email)
            .run();
        },
      },
      changeEmail: {
        enabled: true,
        // The approval link goes to the CURRENT address. Only someone who
        // already controls the account authorizes the change — without this,
        // changing the email becomes a hijack.
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          const { html, text } = emailLayout(
            "Confirm email change",
            [
              `Hi, ${escapeHtml(user.name)}.`,
              `A request was made to change this account's email to <strong>${escapeHtml(newEmail)}</strong>.`,
              "If this was you, confirm with the button below. <strong>If it wasn't, ignore this email and change your password immediately.</strong>",
            ],
            { label: "Confirm change", url },
          );
          await sendEmail(env, { to: user.email, subject: "Confirm email change", html, text });
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // renews at most once a day
      // Sessions live in D1 so they can actually be listed and revoked.
      storeSessionInDatabase: true,
      freshAge: 60 * 15, // sensitive actions require a recent session
    },

    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
      ipAddress: {
        // Behind Cloudflare, the real IP comes in this header.
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },

    rateLimit: {
      // Without this, Better Auth only rate limits in production — we want it
      // testable in dev.
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 300, max: 5 },
        "/request-password-reset": { window: 600, max: 3 },
        "/reset-password": { window: 600, max: 5 },
        "/change-password": { window: 600, max: 5 },
        "/change-email": { window: 600, max: 3 },
      },
    },

    plugins: [
      // ------------------------------------------------------------------
      // Workspaces (the plugin's "organization")
      // ------------------------------------------------------------------
      organizationPlugin({
        ac: acWorkspace,
        roles: workspaceRoles,
        creatorRole: "owner",
        // The plugin's invite table would be called `invitation`, a name that
        // already belonged to this project's global invite table. Renamed to
        // avoid the collision — the two have incompatible required columns.
        schema: { invitation: { modelName: "org_invitation" } },
        // In seconds. Comes from the config so it does not drift from the
        // deadline the privacy policy publishes.
        invitationExpiresIn: 60 * 60 * 24 * INVITE_TTL_DAYS,
        // The plugin already refuses to accept an invite sent to another
        // email (YOU_ARE_NOT_THE_RECIPIENT). We make the second lock explicit
        // instead of relying on its inference: whoever accepts must have
        // confirmed the address, otherwise signing up with an invitee's email
        // would be enough.
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        sendInvitationEmail: async (data) => {
          const url = `${env.BETTER_AUTH_URL}/invite/${data.id}`;
          const { html, text } = emailLayout(
            `Invitation to ${escapeHtml(data.organization.name)}`,
            [
              `${escapeHtml(data.inviter.user.name)} invited you to the workspace ` +
                `<strong>${escapeHtml(data.organization.name)}</strong>.`,
              "If you don't have an account yet, create one with this same email — the invitation " +
                "is only valid for the address that received it.",
            ],
            { label: "View invitation", url },
          );
          await sendEmail(env, {
            to: data.email,
            subject: `Invitation to ${data.organization.name}`,
            html,
            text,
          });
        },
      }),

      twoFactorPlugin({
        // The name shown in the person's authenticator app.
        issuer: APP_NAME,
        // Enabling generates the secret but does NOT turn 2FA on — only the
        // first confirmed code does. That way, abandoning setup halfway
        // (misread QR, dead phone battery) locks no one out.
        skipVerificationOnEnable: false,
        // A TOTP code has six digits: that is 1,000,000 possibilities, which
        // is few for someone who can try at will. Locks after five.
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
      adminPlugin({
        ac,
        roles,
        defaultRole: "user",
        adminRoles: ["admin"],
        bannedUserMessage: "This account is disabled. Contact an administrator.",
      }),
    ],

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Personal workspace and active workspace
    //
    // The invite gate that used to live here was removed: signup is now
    // OPEN. What proved ownership of the email was the invite; now it is the
    // mandatory email verification, right above.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Turnstile at the ENDPOINT, not only on our page
    //
    // `/api/signup` validated Turnstile and then called `/sign-up/email`. But
    // the Better Auth endpoint is public: a direct POST to it created an
    // account without going through any challenge — the anti-bot protection
    // only applied to those who used the form.
    //
    // Now the validation lives here, on the path that EVERY password account
    // creation goes through. The page just forwards the token.
    // ------------------------------------------------------------------
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        if (!env.TURNSTILE_SECRET_KEY) return; // no Turnstile configured, nothing to check

        // During bootstrap there is no system to protect, and the lock is
        // SETUP_SECRET. The exception closes itself: as soon as a superadmin
        // exists, Turnstile applies forever.
        const hasSuperadmin = await env.DB.prepare(
          `SELECT 1 FROM "user" WHERE "role" = 'admin' AND coalesce("banned", 0) = 0 LIMIT 1`,
        ).first();
        if (!hasSuperadmin) return;

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
        const ip =
          ctx.request?.headers.get("cf-connecting-ip") ??
          ctx.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;

        if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip))) {
          throw new APIError("BAD_REQUEST", { message: "TURNSTILE_FAILED" });
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          after: async (newUser) => {
            // Everyone who signs up gets a workspace of their own and becomes
            // its `owner`. Without this, a freshly created account would have
            // nowhere to work and would land on an empty screen.
            //
            // Direct insert through Drizzle (see src/lib/workspaces.ts):
            // calling `auth.api.createOrganization` from here would be
            // reentrant. In exchange the `organizationHooks` do not fire, so
            // the audit entry is recorded right here.
            try {
              const ws = await createWorkspace(env, {
                name: personalWorkspaceName(newUser.name, newUser.email),
                ownerId: newUser.id,
              });

              await writeAudit(env, {
                action: "workspace.created",
                actorId: newUser.id,
                actorEmail: newUser.email,
                workspaceId: ws.id,
                details: { name: ws.name, slug: ws.slug, reason: "signup" },
              });
            } catch (error) {
              // Failing here would leave the account created with no
              // workspace. Better to shout in the log than to carry on
              // silently with a broken state.
              console.error("Failed to create the personal workspace:", error);
            }
          },
        },
      },

      session: {
        create: {
          before: async (newSession) => {
            // The plugin does NOT set the active organization at login — it
            // has no `init` and no session hooks. Without this,
            // `activeOrganizationId` would start out null and the dashboard
            // would not know where to send the person.
            //
            // This is convenience, not authorization: what authorizes is the
            // URL slug checked against the membership.
            const first = await env.DB.prepare(
              `SELECT "organizationId" FROM "member"
                WHERE "userId" = ?1 ORDER BY "createdAt" LIMIT 1`,
            )
              .bind(newSession.userId)
              .first<{ organizationId: string }>();

            return {
              data: { ...newSession, activeOrganizationId: first?.organizationId ?? null },
            };
          },
        },
      },
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}


/**
 * Calls a Better Auth route through the HTTP handler, not through `auth.api.*`.
 *
 * The difference matters: `auth.api.signInEmail()` runs the endpoint but skips
 * the router layer — where the RATE LIMITER lives. Six wrong-password attempts
 * went through without ever hitting the 5/minute limit. Going through the
 * handler, the request follows the same path as a POST coming from the browser:
 * rate limit, origin check, hooks and everything else.
 *
 * Used by the credential routes (sign in, invite, reset, password change). The
 * already authenticated admin and profile routes stay on `auth.api.*`, where
 * the session is the barrier and the typing helps more.
 */
export async function callAuth(
  auth: Auth,
  request: Request,
  path: `/${string}`,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");

  return auth.handler(
    new Request(new URL(`/api/auth${path}`, new URL(request.url).origin), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Name of the workspace that is born with the account. Uses the first name when
 * there is one; otherwise falls back to the local part of the email, which
 * always exists.
 */
function personalWorkspaceName(name: string | null | undefined, email: string): string {
  const first = String(name ?? "").trim().split(/\s+/)[0];
  return `${first || email.split("@")[0]}'s workspace`;
}

/**
 * Writes to the audit log in raw SQL, not through `audit()` from `~/lib/audit`,
 * because that module imports `getDb` from here — using it would create an
 * import cycle. Same reason as `deleteUser.afterDelete` right above.
 */
async function writeAudit(
  env: AppEnv,
  entry: {
    action: string;
    actorId?: string | null;
    actorEmail?: string | null;
    targetId?: string | null;
    targetEmail?: string | null;
    workspaceId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO "audit_log"
         ("id","createdAt","actorId","actorEmail","action","targetId","targetEmail","details","workspaceId")
       VALUES (?1, unixepoch(), ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        crypto.randomUUID(),
        entry.actorId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.targetId ?? null,
        entry.targetEmail ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.workspaceId ?? null,
      )
      .run();
  } catch (error) {
    // Auditing never takes down the operation it is recording.
    console.error("Failed to write audit_log:", error);
  }
}
