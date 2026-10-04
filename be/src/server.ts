/**
 * Server entry point (design Section 2, 4.2).
 *
 * Loads + validates config (fail-fast), seeds a fresh store, builds the app,
 * and listens. This is the documented seeded start command: `npm run dev` /
 * `npm start` (both run `tsx src/server.ts`).
 */

import { buildApp } from "./http/app.js";
import { loadConfig, seedProducts } from "./config.js";
import { createStore } from "./store/store.js";

async function main(): Promise<void> {
  // loadConfig throws before we ever listen if REWARD_N / REWARD_X are invalid.
  const config = loadConfig(process.env);
  const store = createStore(seedProducts());
  const app = buildApp({ store, config, logger: true });

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  // Fail-fast on config/startup errors (invalid reward config, etc.).
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
