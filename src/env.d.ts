/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

import type { Auth } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";
import type { Membership } from "~/lib/workspaces";

type SessionPayload = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/**
 * O plugin two-factor acrescenta este campo em runtime, mas ele não aparece no
 * tipo inferido da sessão. Sem isto, o gate de 2FA do middleware dependeria de
 * um cast silencioso — e um gate de segurança não deveria depender disso.
 */
type UsuarioDaSessao = SessionPayload["user"] & { twoFactorEnabled?: boolean | null };

declare global {
  namespace App {
    // O adapter já declara `Locals extends Runtime` (com `cfContext`);
    // esta declaração funde os nossos campos nela.
    interface Locals {
      /** Instância do Better Auth desta requisição (cacheada por isolate). */
      auth: Auth;
      /** Bindings e secrets do Worker. */
      env: AppEnv;

      /** Resolvidos pelo middleware. `null` = anônimo. */
      user: UsuarioDaSessao | null;
      session: SessionPayload["session"] | null;

      /**
       * O workspace da URL e o papel da pessoa nele, resolvidos pelo middleware
       * a partir do slug em `/w/[slug]/…`.
       *
       * `null` fora de uma rota de workspace. Quando existe, já foi conferido
       * contra a membership — é ele que autoriza, nunca o `activeOrganizationId`
       * da sessão, que é só memória do último usado.
       */
      membership: Membership | null;
    }
  }
}

export {};
