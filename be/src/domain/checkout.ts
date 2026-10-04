/**
 * Checkout + orders service (design Section 7) — the critical section.
 *
 * The entire checkout body runs as ONE serialized executor task, so steps 1-7
 * form a single atomic critical section with no un-awaited gaps. Ordering is
 * deliberate (design 7.2):
 *   1. Idempotency-Key lookup FIRST (fingerprint = `${cartId}|${couponCode ?? ""}`, F3).
 *   2. Load cart; if checked_out, header-less replay comparison.
 *   3. Reject empty cart.
 *   4. RESERVE coupon BEFORE inventory validation (makes the release path reachable).
 *   5. Validate each line fresh (read-only; no inventory mutation here).
 *   6. Compute subtotal + clamped discount.
 *   7. COMMIT: decrement inventory, insert order (milestoneSequence = orders.size
 *      AFTER insert, F2), redeem coupon, mark cart checked_out, write idempotency
 *      record (commit only).
 * On ANY pre-commit failure after reservation, the coupon is released.
 */

import { AppError } from "../errors.js";
import { lineSubtotal, newId, percentDiscount, sum } from "../money.js";
import { redeemCoupon, releaseCoupon, reserveCoupon } from "./coupons.js";
import type { Config } from "../config.js";
import type { Store } from "../store/store.js";
import type { SerialExecutor } from "../store/executor.js";
import type { Coupon, Order, OrderLine } from "./types.js";

/** Inputs to a checkout request. */
export interface CheckoutInput {
  cartId: string;
  couponCode: string | null;
  idempotencyKey: string | null;
}

/** The result of a checkout: the order body plus the HTTP semantics. */
export interface CheckoutResult {
  order: Order;
  /** 201 for a fresh checkout, 200 for an idempotent replay. */
  httpStatus: 200 | 201;
  /** True only on a 200 replay (sets the Idempotent-Replay response header). */
  replay: boolean;
}

/** Build the fingerprint compared across same-key retries (design F3). */
function fingerprint(cartId: string, couponCode: string | null): string {
  return `${cartId}|${couponCode ?? ""}`;
}

/** Wrap an order in the response body shape (design Section 10). */
function orderBody(order: Order): { order: Order } {
  return { order };
}

/**
 * Run a checkout as a single serialized executor task. The caller (the route)
 * invokes `executor.run` indirectly through this; the HTTP handler itself
 * passes the returned promise straight to the reply with NO preceding await
 * (NIT a).
 */
export function checkout(
  store: Store,
  executor: SerialExecutor,
  config: Config,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const { cartId, couponCode, idempotencyKey } = input;

  return executor.run(async () => {
    // 1. Idempotency-Key lookup FIRST (before any cart-status check).
    if (idempotencyKey !== null) {
      const record = store.idempotency.get(idempotencyKey);
      if (record) {
        if (record.requestFingerprint === fingerprint(cartId, couponCode)) {
          // Replay the stored response (same body, 200, Idempotent-Replay).
          return {
            order: (record.responseBody as { order: Order }).order,
            httpStatus: 200,
            replay: true,
          };
        }
        // Same key, different cart/coupon -> reuse error.
        throw new AppError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key reused with different request parameters",
        );
      }
      // No record: fall through as a fresh attempt (record written only on commit).
    }

    // 2. Load cart; must exist.
    const cart = store.carts.get(cartId);
    if (!cart) {
      throw new AppError("CART_NOT_FOUND", `cart '${cartId}' not found`);
    }
    if (cart.status === "checked_out") {
      // Header-less replay comparison: compare the requested coupon to the
      // stored order's coupon (both normalized to null).
      const order = cart.orderId ? store.orders.get(cart.orderId) : undefined;
      if (order && (order.couponCode ?? null) === (couponCode ?? null)) {
        return { order, httpStatus: 200, replay: true };
      }
      throw new AppError(
        "CART_ALREADY_CHECKED_OUT",
        `cart '${cartId}' is already checked out`,
      );
    }

    // 3. Reject empty cart.
    if (cart.lines.length === 0) {
      throw new AppError("CART_EMPTY", `cart '${cartId}' is empty`);
    }

    // 4. RESERVE coupon FIRST (if supplied), before inventory validation.
    let reserved: Coupon | null = null;
    if (couponCode !== null) {
      reserved = reserveCoupon(store, couponCode);
    }

    try {
      // 5. Validate each line fresh; capture current price. READ-ONLY (no
      //    inventory mutation here — the decrement is step 7a), so no partial
      //    inventory side effect can exist across lines.
      const orderLines: OrderLine[] = cart.lines.map((line) => {
        const product = store.products.get(line.productId);
        if (!product) {
          throw new AppError(
            "PRODUCT_UNAVAILABLE",
            `product '${line.productId}' is no longer available`,
          );
        }
        if (product.inventory < line.quantity) {
          throw new AppError(
            "INSUFFICIENT_INVENTORY",
            `insufficient inventory for product '${line.productId}'`,
          );
        }
        return {
          productId: product.id,
          name: product.name,
          unitPriceCents: product.priceCents,
          quantity: line.quantity,
          lineSubtotalCents: lineSubtotal(product.priceCents, line.quantity),
        };
      });

      // 6. Compute subtotal + clamped discount.
      const subtotalCents = sum(orderLines.map((l) => l.lineSubtotalCents));
      const discountCents = reserved
        ? percentDiscount(subtotalCents, reserved.percentOff)
        : 0;
      const totalCents = subtotalCents - discountCents;

      // 7. COMMIT (all-or-nothing, still inside the same task).
      // a. decrement inventory.
      for (const line of orderLines) {
        const product = store.products.get(line.productId)!;
        product.inventory -= line.quantity;
      }
      // b/c. insert order, then set milestoneSequence = orders.size AFTER insert (F2).
      const order: Order = {
        id: newId("order"),
        cartId: cart.id,
        lines: orderLines,
        subtotalCents,
        discountCents,
        totalCents,
        couponCode: reserved ? reserved.code : null,
        createdAt: new Date().toISOString(),
        milestoneSequence: 0, // set immediately after insert below
      };
      store.orders.set(order.id, order);
      order.milestoneSequence = store.orders.size;
      // d. redeem the reserved coupon.
      if (reserved) {
        redeemCoupon(reserved, order.id);
      }
      // e. mark cart checked out.
      cart.status = "checked_out";
      cart.orderId = order.id;
      cart.updatedAt = new Date().toISOString();
      // f. write the idempotency record (commit only).
      if (idempotencyKey !== null) {
        store.idempotency.set(idempotencyKey, {
          key: idempotencyKey,
          cartId: cart.id,
          requestFingerprint: fingerprint(cartId, couponCode),
          status: "completed",
          orderId: order.id,
          responseBody: orderBody(order),
        });
      }

      // 8. Return 201 with order body.
      return { order, httpStatus: 201, replay: false };
    } catch (err) {
      // On ANY pre-commit failure after reservation: release the coupon. No
      // inventory was decremented yet (decrement is step 7a), and no record
      // was written (write is step 7f), so a retry proceeds cleanly.
      if (reserved) {
        releaseCoupon(reserved);
      }
      throw err;
    }
  });
}

/** Read-only order lookup by id (ORDER_NOT_FOUND if absent). */
export function getOrder(store: Store, orderId: string): Order {
  const order = store.orders.get(orderId);
  if (!order) {
    throw new AppError("ORDER_NOT_FOUND", `order '${orderId}' not found`);
  }
  return order;
}
