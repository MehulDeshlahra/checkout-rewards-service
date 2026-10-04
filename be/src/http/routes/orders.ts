/**
 * Order routes (design Section 10): read-only.
 *   GET /orders/:id -> ORDER_NOT_FOUND (404) if absent.
 */

import { getOrder } from "../../domain/checkout.js";
import type { FastifyInstance } from "fastify";
import type { Store } from "../../store/store.js";

export function registerOrderRoutes(app: FastifyInstance, store: Store): void {
  app.get<{ Params: { id: string } }>("/orders/:id", async (req) => {
    return { order: getOrder(store, req.params.id) };
  });
}
