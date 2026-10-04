/**
 * Checkout route (design Section 10).
 *   POST /carts/:id/checkout   headers { Idempotency-Key? }   body { couponCode? }
 *
 * NIT a: the handler calls checkout(...) (which submits to the executor) with
 * NO preceding await — the returned promise is awaited once, directly, to shape
 * the reply. No work runs before the task is submitted.
 */

import { z } from "zod";
import { checkout } from "../../domain/checkout.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../config.js";
import type { SerialExecutor } from "../../store/executor.js";
import type { Store } from "../../store/store.js";

const checkoutBodySchema = z.object({
  // Same charset genCode() produces (design Section 11); exact, case-sensitive.
  couponCode: z
    .string()
    .regex(/^[A-Z0-9-]{1,64}$/)
    .optional(),
});

const idempotencyKeySchema = z.string().min(1).max(200);

export function registerCheckoutRoute(
  app: FastifyInstance,
  store: Store,
  executor: SerialExecutor,
  config: Config,
): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/carts/:id/checkout",
    (req, reply) => {
      const body = checkoutBodySchema.parse(req.body ?? {});

      const rawKey = req.headers["idempotency-key"];
      let idempotencyKey: string | null = null;
      if (rawKey !== undefined) {
        const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
        // Present-but-empty is rejected as a validation error.
        idempotencyKey = idempotencyKeySchema.parse(key);
      }

      // NIT a: submit the executor task with NO preceding await.
      return checkout(store, executor, config, {
        cartId: req.params.id,
        couponCode: body.couponCode ?? null,
        idempotencyKey,
      }).then((result) => {
        if (result.replay) {
          reply.header("Idempotent-Replay", "true");
        }
        reply.code(result.httpStatus).send({ order: result.order });
      });
    },
  );
}
