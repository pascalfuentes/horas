import type { APIRoute } from "astro";

export const prerender = false;

/**
 * Catch-all do Better Auth: /api/auth/sign-in/email, /api/auth/reset-password,
 * /api/auth/admin/*, etc. O middleware deixa este prefixo passar direto — cada
 * rota faz a própria autorização.
 */
const handler: APIRoute = ({ request, locals }) => locals.auth.handler(request);

export const GET = handler;
export const POST = handler;
