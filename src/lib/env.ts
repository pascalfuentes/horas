import { env as cloudflareEnv } from "cloudflare:workers";

/**
 * `Env` global vem de `worker-configuration.d.ts`, gerado por `wrangler types`
 * a partir das bindings do wrangler.jsonc. Secrets não aparecem lá (eles não
 * ficam no arquivo de config), então são declarados aqui.
 */
export type AppEnv = Env & {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  SETUP_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  // Login social. Cada provedor só aparece quando o par de chaves existe.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // Aparecem na política de privacidade. Públicos, então ficam em `vars`.
  OPERATOR_NAME?: string;
  OPERATOR_CONTACT?: string;
};

/** Provedores sociais efetivamente configurados neste ambiente. */
export function socialProviders(value: AppEnv): Array<"google" | "github"> {
  const lista: Array<"google" | "github"> = [];
  if (value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET) lista.push("google");
  if (value.GITHUB_CLIENT_ID && value.GITHUB_CLIENT_SECRET) lista.push("github");
  return lista;
}

/**
 * Bindings e secrets do Worker. Em `astro dev` o plugin da Cloudflare roda o
 * código no workerd de verdade e preenche isto a partir do wrangler.jsonc e
 * do `.dev.vars` — o mesmo objeto que existe em produção.
 */
export const env = cloudflareEnv as AppEnv;

/**
 * Falha cedo e alto se um secret obrigatório não estiver configurado — melhor
 * quebrar no primeiro request do que rodar com criptografia fraca.
 */
export function assertEnv(value: AppEnv): asserts value is AppEnv {
  if (!value.BETTER_AUTH_SECRET || value.BETTER_AUTH_SECRET.length < 24) {
    throw new Error(
      "BETTER_AUTH_SECRET ausente ou curto demais. Gere com `openssl rand -base64 32` " +
        "e coloque em .dev.vars (dev) ou `wrangler secret put` (produção).",
    );
  }
  if (!value.BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL ausente. Ex.: http://localhost:4321 em dev.");
  }
}
