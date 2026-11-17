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

/**
 * Whether a request arrived over plain HTTP at a site that is served over
 * HTTPS. Such a request carried whatever it carried (a password, a session
 * cookie would not go: it is `Secure`) in the clear, and the page it gets back
 * can be rewritten on the way by anyone in the middle.
 *
 * Behind a tunnel or another proxy the Worker sees plain HTTP for a request
 * that was HTTPS on the visitor's side. The proxy says so in
 * `X-Forwarded-Proto` (Cloudflare also in `CF-Visitor`), and that is believed:
 * sending the header by hand only spares the sender's own request from the
 * redirect. Once the address says `https:` the answer is always "no", so on
 * Cloudflare the redirect this decides cannot point at itself. Only a proxy
 * that ends HTTPS itself and says so in neither header would loop.
 *
 * Nothing local counts, for the same reason as in `elsewhere`.
 *
 * @param url The address the request arrived at.
 * @param headers The request's headers.
 * @param siteAddress The site's address, as configured in `BETTER_AUTH_URL`.
 * @returns `true` when the request should have come over HTTPS and did not.
 */
export function overPlainHttp(url: URL, headers: Headers, siteAddress: string | undefined): boolean {
  if (!servedOverHttps(url, siteAddress)) return false;
  if (url.protocol !== "http:") return false;

  const forwarded = (headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (forwarded === "https") return false;
  return !/"scheme"\s*:\s*"https"/i.test(headers.get("cf-visitor") ?? "");
}

/**
 * Whether this is a real site served over HTTPS: the configured address says
 * `https://` and neither it nor the request is a local one. Only then may the
 * browser be told to never use plain HTTP for this host again.
 *
 * @param url The address the request arrived at.
 * @param siteAddress The site's address, as configured in `BETTER_AUTH_URL`.
 * @returns `true` for a site that has HTTPS and should insist on it.
 */
export function servedOverHttps(url: URL, siteAddress: string | undefined): boolean {
  let site: URL;
  try {
    site = new URL(siteAddress ?? "");
  } catch {
    return false;
  }
  if (site.protocol !== "https:") return false;
  return !LOCAL.test(site.hostname) && !LOCAL.test(url.hostname);
}
