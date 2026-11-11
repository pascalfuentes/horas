import type { APIRoute } from "astro";

import { redirectWithCookies } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const res = await locals.auth.api.signOut({ headers: request.headers, asResponse: true });
  return redirectWithCookies(res, "/login");
};
