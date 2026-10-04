/**
 * Admin routes (design Section 10). Unauthenticated but documented as
 * administrative.
 *   POST /admin/coupons/generate -> 201 { coupon }
 *   GET  /admin/coupons          -> 200 [{ code, percentOff, milestone, status }]  (NIT b)
 *   GET  /admin/report           -> 200 { report }  (strictly read-only, F1)
 */

import { generateCoupon, listCoupons } from "../../domain/coupons.js";
import { buildReport } from "../../domain/reporting.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../config.js";
import type { SerialExecutor } from "../../store/executor.js";
import type { Store } from "../../store/store.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  store: Store,
  executor: SerialExecutor,
  config: Config,
): void {
  app.post("/admin/coupons/generate", async (_req, reply) => {
    const coupon = await generateCoupon(store, executor, config);
    reply.code(201).send({ coupon });
  });

  // NIT b: the list includes each coupon's status.
  app.get("/admin/coupons", async () => {
    return listCoupons(store);
  });

  // Read-only: the handler just calls the synchronous builder and replies, with
  // no await between the builder's internal reads (rule R-REPORT-SYNC, F1).
  app.get("/admin/report", async () => {
    return buildReport(store, config);
  });
}
