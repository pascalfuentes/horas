#!/usr/bin/env node
/**
 * Signs in with a social provider against the REAL Better Auth, with only the
 * network faked, and says whether an account with two-step verification is
 * asked for its code.
 *
 * It exists because that path cannot be walked on a developer's machine: the
 * provider's addresses are fixed inside the library, so a real return from
 * Google or GitHub needs a real Google or GitHub. Here the library is built in
 * Node with an in-memory database and the same change the app applies
 * (`src/lib/second-factor.ts`), and GitHub's three answers are made up.
 *
 * It also guards the day the library is updated: the change leans on a step
 * of the two-factor plugin, and this says at once if that step moved.
 *
 *   node scripts/social-2fa-check.mjs
 *
 * Prints one line per thing checked, "ok ..." or "FAIL ...", and exits with 1
 * if any failed.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins/two-factor";

import { totp } from "./totp.mjs";

(async () => {
  const { askAfterSocialSignIn, secondFactorStep } = await import("../src/lib/second-factor.ts");

  const ORIGIN = "http://localhost:4321";
  const PASSWORD = "a-long-password-for-the-check";
  let failed = 0;

  /**
   * Prints the result of one check.
   * @param {string} what What was checked.
   * @param {boolean} good Whether it came out as it should.
   * @param {string} [got] What was seen, shown when it did not.
   * @returns {void}
   */
  function report(what, good, got) {
    if (!good) failed++;
    console.log(`${good ? "ok" : "FAIL"} ${what}${good || got === undefined ? "" : ` (got: ${got})`}`);
  }

  /**
   * The address GitHub would say the person has. Changed between sign-ins.
   * @type {{ email: string, id: number }}
   */
  const github = { email: "", id: 0 };

  /**
   * Stands in for the network: GitHub's token exchange and its two profile
   * answers. Anything else is refused, so the check never leaves the machine.
   * @param {RequestInfo | URL} input
   * @returns {Promise<Response>}
   */
  async function fakeFetch(input) {
    const url = String(input instanceof Request ? input.url : input);
    /**
     * @param {unknown} data
     * @returns {Response}
     */
    const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return json({ access_token: "made-up", token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url === "https://api.github.com/user/emails") {
      return json([{ email: github.email, primary: true, verified: true, visibility: "private" }]);
    }
    if (url === "https://api.github.com/user") {
      return json({ id: github.id, login: "someone", name: "Someone", email: github.email, avatar_url: "" });
    }
    return new Response("the check does not reach the network", { status: 599 });
  }
  globalThis.fetch = fakeFetch;

  /**
   * Builds the library the way the check needs it.
   * @param {boolean} withTheChange Whether the app's change to the plugin is applied.
   * @returns {{ auth: ReturnType<typeof betterAuth>, db: Record<string, any[]> }}
   */
  function build(withTheChange) {
    /** @type {Record<string, any[]>} */
    const db = { user: [], session: [], account: [], verification: [], twoFactor: [], rateLimit: [] };
    const plugin = twoFactor({ issuer: "Check", skipVerificationOnEnable: false });
    const auth = betterAuth({
      baseURL: ORIGIN,
      secret: "0123456789abcdef0123456789abcdef",
      database: memoryAdapter(db),
      emailAndPassword: { enabled: true, minPasswordLength: 10 },
      socialProviders: { github: { clientId: "made-up", clientSecret: "made-up" } },
      account: { accountLinking: { enabled: true, trustedProviders: ["github"] } },
      rateLimit: { enabled: false },
      logger: { disabled: true },
      plugins: [withTheChange ? askAfterSocialSignIn(plugin) : plugin],
    });
    return { auth, db };
  }

  /**
   * A browser's cookie jar, enough of one for this.
   * @returns {{ header: () => string, take: (response: Response) => void, has: (name: string) => boolean }}
   */
  function jar() {
    /** @type {Map<string, string>} */
    const cookies = new Map();
    return {
      header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      take(response) {
        for (const line of response.headers.getSetCookie()) {
          const [pair, ...attributes] = line.split(";");
          const at = pair.indexOf("=");
          const name = pair.slice(0, at).trim();
          const gone = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || pair.slice(at + 1) === "";
          if (gone) cookies.delete(name);
          else cookies.set(name, pair.slice(at + 1));
        }
      },
      has: (name) => [...cookies.keys()].some((key) => key.endsWith(name)),
    };
  }

  /**
   * Sends one request to the library, as a browser holding `cookies` would.
   * @param {ReturnType<typeof betterAuth>} auth
   * @param {ReturnType<typeof jar>} cookies
   * @param {string} method
   * @param {string} path Path under /api/auth, with its query.
   * @param {unknown} [body]
   * @returns {Promise<Response>}
   */
  async function call(auth, cookies, method, path, body) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method,
        headers: { origin: ORIGIN, cookie: cookies.header(), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    cookies.take(response);
    return response;
  }

  /**
   * Goes to the provider and comes back, the way the two requests of a social
   * sign-in do.
   * @param {ReturnType<typeof betterAuth>} auth
   * @param {ReturnType<typeof jar>} cookies
   * @param {string} wanted The page the person was going to.
   * @returns {Promise<Response>} The library's answer to the return.
   */
  async function socialSignIn(auth, cookies, wanted) {
    const start = await call(auth, cookies, "POST", "/sign-in/social", { provider: "github", callbackURL: wanted });
    const { url } = await start.json();
    const state = new URL(url).searchParams.get("state");
    return call(auth, cookies, "GET", `/callback/github?code=made-up&state=${encodeURIComponent(state ?? "")}`);
  }

  /**
   * Creates an account with a password, confirmed, and turns two-step
   * verification on.
   * @param {ReturnType<typeof betterAuth>} auth
   * @param {Record<string, any[]>} db
   * @param {string} email
   * @returns {Promise<string>} The secret an authenticator app would hold.
   */
  async function accountWithSecondFactor(auth, db, email) {
    const cookies = jar();
    await call(auth, cookies, "POST", "/sign-up/email", { name: "Someone", email, password: PASSWORD });
    // As after the confirmation e-mail: the library only joins a social login
    // to an account whose address was confirmed.
    for (const user of db.user) if (user.email === email) user.emailVerified = true;
    const enabled = await (await call(auth, cookies, "POST", "/two-factor/enable", { password: PASSWORD })).json();
    const secret = new URL(enabled.totpURI).searchParams.get("secret") ?? "";
    await call(auth, cookies, "POST", "/two-factor/verify-totp", { code: totp(secret) });
    await call(auth, cookies, "POST", "/sign-out", {});
    return secret;
  }

  // ---- With the app's change ---------------------------------------------
  {
    const { auth, db } = build(true);
    const email = "with-code@example.com";
    const secret = await accountWithSecondFactor(auth, db, email);
    report("the account has two-step verification on", db.user[0]?.twoFactorEnabled === true, String(db.user[0]?.twoFactorEnabled));
    report("and nobody is signed in before the social sign-in", db.session.length === 0, String(db.session.length));

    github.email = email;
    github.id = 101;
    const cookies = jar();
    const back = await socialSignIn(auth, cookies, "/w/somewhere/time?a=1");
    report("the social account was linked to it", db.account.some((a) => a.providerId === "github"), JSON.stringify(db.account.map((a) => a.providerId)));
    report("coming back from the provider opens NO session", db.session.length === 0, String(db.session.length));
    report("and leaves no session cookie", !cookies.has("session_token"), cookies.header().replace(/=[^;]*/g, "=…"));
    report("only the short-lived one the code page uses", cookies.has("two_factor"), cookies.header().replace(/=[^;]*/g, "=…"));

    const step = await secondFactorStep(back, ORIGIN, (value) => value);
    report("the person is sent to the code page", step?.status === 303 && (step.headers.get("location") ?? "").startsWith("/two-factor?"), `${step?.status} ${step?.headers.get("location")}`);
    report("which remembers where they were going", step?.headers.get("location") === `/two-factor?next=${encodeURIComponent("/w/somewhere/time?a=1")}`, String(step?.headers.get("location")));
    report("and carries the library's cookies", (step?.headers.getSetCookie() ?? []).some((c) => /two_factor=/.test(c)), String(step?.headers.getSetCookie().length));

    const wrong = await call(auth, cookies, "POST", "/two-factor/verify-totp", { code: "000000" });
    report("a wrong code still opens nothing", !wrong.ok && db.session.length === 0, `${wrong.status}, sessions ${db.session.length}`);
    const right = await call(auth, cookies, "POST", "/two-factor/verify-totp", { code: totp(secret) });
    report("the right code opens the session", right.ok && db.session.length === 1 && cookies.has("session_token"), `${right.status}, sessions ${db.session.length}`);

    // An account without two-step verification signs in as it always did.
    github.email = "no-code@example.com";
    github.id = 102;
    const plain = jar();
    const straight = await socialSignIn(auth, plain, "/dashboard");
    report("an account without two-step verification goes straight in", plain.has("session_token") && db.session.length === 2, `sessions ${db.session.length}`);
    report("to the page it asked for", (straight.headers.get("location") ?? "").endsWith("/dashboard"), String(straight.headers.get("location")));
    report("and is not sent to the code page", (await secondFactorStep(straight, ORIGIN, (value) => value)) === null);
  }

  // ---- Without it: what the library does by itself -----------------------
  // Not a check of the app. It shows the hole the change closes, and the day
  // the library closes it by itself this line says so.
  {
    const { auth, db } = build(false);
    const email = "with-code@example.com";
    await accountWithSecondFactor(auth, db, email);
    github.email = email;
    github.id = 101;
    await socialSignIn(auth, jar(), "/dashboard");
    console.log(
      db.session.length === 1
        ? "note: without the change, the library opens the session with no code (the hole is still there to close)"
        : "note: without the change, the library no longer opens the session; second-factor.ts may not be needed any more",
    );
  }

  console.log(failed ? `social-2fa: ${failed} FAILED` : "social-2fa: all ok");
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.log(`FAIL the check itself broke: ${error?.stack ?? error}`);
  process.exit(1);
});
