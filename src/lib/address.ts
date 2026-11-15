/**
 * The site has ONE address: the one in `BETTER_AUTH_URL`. The session cookie,
 * the origin check and the links in the e-mails only work there, so any other
 * way in (the `*.workers.dev` address next to a custom domain, or the domain
 * the site used to have) is a page that loads and then refuses the login.
 */

/** Addresses that only exist on the developer's machine. */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

/**
 * Where to send a request that arrived at another address: the same path and
 * query at the site's address. `null` when it is already in the right place.
 *
 * Only the host is compared. The scheme is left alone on purpose: behind a
 * tunnel the Worker sees plain HTTP for a site that is served over HTTPS, and
 * "fixing" that here would be a redirect to itself, forever.
 *
 * Nothing is redirected in development: with a local site address there is
 * nowhere to send anyone, and a request that reaches the machine as
 * `127.0.0.1` instead of `localhost` should simply work.
 *
 * @param url The address the request arrived at.
 * @param siteAddress The site's address, as configured in `BETTER_AUTH_URL`.
 * @returns The address to redirect to, or `null` to answer the request here.
 */
export function elsewhere(url: URL, siteAddress: string | undefined): string | null {
  let site: URL;
  try {
    site = new URL(siteAddress ?? "");
  } catch {
    // Missing or malformed. `assertEnv` is the one that complains, and loudly.
    return null;
  }

  if (LOCAL.test(site.hostname) || LOCAL.test(url.hostname)) return null;
  if (url.host === site.host) return null;

  return site.origin + url.pathname + url.search;
}
