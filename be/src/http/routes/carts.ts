/**
 * Cart routes (design Section 10).
 *   POST   /carts
 *   GET    /carts/:id
 *   POST   /carts/:id/items                body { productId, quantity }
 *   PATCH  /carts/:id/items/:productId     body { quantity }
 *   DELETE /carts/:id/items/:productId
 *
 * Request bodies are validated with zod; a failure is thrown as a ZodError and
 * mapped to VALIDATION_ERROR (400) by the central error handler.
 */

import { z } from "zod";
import {
  addItem,
  createCart,
  getCartView,
  removeItem,
  updateQty,
} from "../../domain/carts.js";
import type { FastifyInstance } from "fastify";
import type { SerialExecutor } from "../../store/executor.js";
import type { Store } from "../../store/store.js";

const addItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number(),
});

const updateQtySchema = z.object({
  quantity: z.number(),
});

export function registerCartRoutes(
  app: FastifyInstance,
  store: Store,
  executor: SerialExecutor,
): void {
  app.post("/carts", async (_req, reply) => {
    const cart = await createCart(store, executor);
    reply.code(201).send(cart);
  });

  app.get<{ Params: { id: string } }>("/carts/:id", async (req) => {
    return getCartView(store, req.params.id);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/carts/:id/items",
    async (req) => {
      const { productId, quantity } = addItemSchema.parse(req.body);
      return addItem(store, executor, req.params.id, productId, quantity);
    },
  );

  app.patch<{ Params: { id: string; productId: string }; Body: unknown }>(
    "/carts/:id/items/:productId",
    async (req) => {
      const { quantity } = updateQtySchema.parse(req.body);
      return updateQty(store, executor, req.params.id, req.params.productId, quantity);
    },
  );

  app.delete<{ Params: { id: string; productId: string } }>(
    "/carts/:id/items/:productId",
    async (req) => {
      return removeItem(store, executor, req.params.id, req.params.productId);
    },
  );
}
