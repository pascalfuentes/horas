import type { APIRoute } from "astro";

export const prerender = false;

/**
 * Better Auth catch-all: /api/auth/sign-in/email, /api/auth/reset-password,
 * /api/auth/admin/*, etc. The middleware lets this prefix straight through —
 * each route does its own authorization.
 */
const handler: APIRoute = ({ request, locals }) => locals.auth.handler(request);

export const GET = handler;
export const POST = handler;
