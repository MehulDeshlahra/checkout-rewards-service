/**
 * Fastify app factory (design Section 4.2, 10).
 *
 * buildApp({ store, config, yieldHook? }) returns a Fastify instance with the
 * error handler and all routes registered over an injected store + config and
 * a fresh SerialExecutor. Tests build a fresh app per scenario for determinism.
 *
 * The optional yieldHook is accepted for parity with the design's injectable
 * seam but is NOT wired into any route (design Section 4.2: it exists only for
 * the SerialExecutor unit test and must never park a task on the hot path).
 */

import Fastify from "fastify";
import { SerialExecutor } from "../store/executor.js";
import { registerErrorHandler } from "./error-handler.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCartRoutes } from "./routes/carts.js";
import { registerCheckoutRoute } from "./routes/checkout.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerProductRoutes } from "./routes/products.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Store } from "../store/store.js";
import type { YieldHook } from "../store/executor.js";

export interface BuildAppDeps {
  store: Store;
  config: Config;
  /**
   * Accepted for the design's injectable-seam parity only. It is intentionally
   * not placed on any route (design Section 4.2).
   */
  yieldHook?: YieldHook;
  /** Fastify logger toggle; off by default (quiet tests). */
  logger?: boolean;
}

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const { store, config, logger = false } = deps;
  const app = Fastify({ logger });
  const executor = new SerialExecutor();

  registerErrorHandler(app);

  registerProductRoutes(app, store);
  registerCartRoutes(app, store, executor);
  registerCheckoutRoute(app, store, executor, config);
  registerOrderRoutes(app, store);
  registerAdminRoutes(app, store, executor, config);

  return app;
}
