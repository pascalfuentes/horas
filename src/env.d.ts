/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

import type { Auth } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";
import type { Membership } from "~/lib/workspaces";

type SessionPayload = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/**
 * The two-factor plugin adds this field at runtime, but it does not show up in
 * the inferred session type. Without this, the middleware's 2FA gate would
 * depend on a silent cast — and a security gate should not depend on that.
 */
type SessionUser = SessionPayload["user"] & { twoFactorEnabled?: boolean | null };

declare global {
  namespace App {
    // The adapter already declares `Locals extends Runtime` (with `cfContext`);
    // this declaration merges our fields into it.
    interface Locals {
      /** This request's Better Auth instance (cached per isolate). */
      auth: Auth;
      /** The Worker's bindings and secrets. */
      env: AppEnv;

      /** Resolved by the middleware. `null` = anonymous. */
      user: SessionUser | null;
      session: SessionPayload["session"] | null;

      /**
       * The workspace in the URL and the person's role in it, resolved by the
       * middleware from the slug in `/w/[slug]/…`.
       *
       * `null` outside a workspace route. When present, it has already been
       * checked against the membership — it is what authorizes, never the
       * session's `activeOrganizationId`, which is only a memory of the last
       * one used.
       */
      membership: Membership | null;
    }
  }
}

export {};
