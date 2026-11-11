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
    // Validates the origin on POST/PUT/PATCH/DELETE coming from forms.
    checkOrigin: true,
  },
  devToolbar: { enabled: false },
});
