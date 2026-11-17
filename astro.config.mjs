// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { configPath } from "./scripts/config.mjs";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // wrangler.local.jsonc when it exists; wrangler.jsonc (template) otherwise.
    configPath: configPath(),
    // Keeps the local D1 in .wrangler/state between `astro dev` and
    // `wrangler d1 migrations apply --local`. Without this the migrations would
    // run on one database and the dev server would read another.
    persistState: true,
  }),
  security: {
    // Off on purpose, and replaced: `src/middleware.ts` checks the origin of
    // every request that changes something, whatever its content type. The
    // built-in check runs before any of the app's code and also refuses a
    // DELETE or a POST without `Content-Type` on the token API, where there is
    // no cookie to protect and no page to send an origin.
    checkOrigin: false,
  },
  devToolbar: { enabled: false },
});
