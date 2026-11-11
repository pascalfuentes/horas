// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { configPath } from "./scripts/config.mjs";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // wrangler.local.jsonc quando existe; wrangler.jsonc (template) caso contrário.
    configPath: configPath(),
    // Mantém o D1 local em .wrangler/state entre `astro dev` e
    // `wrangler d1 migrations apply --local` — sem isso as migrations rodariam
    // num banco e o dev server leria outro.
    persistState: true,
  }),
  security: {
    // Valida a origem em POST/PUT/PATCH/DELETE vindos de formulário.
    checkOrigin: true,
  },
  devToolbar: { enabled: false },
});
