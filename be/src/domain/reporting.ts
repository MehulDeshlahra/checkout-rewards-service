/**
 * Reporting (design Section 12) — read-only, reconciling.
 *
 * buildReport is FULLY SYNCHRONOUS (rule R-REPORT-SYNC, finding F1): it reads
 * orders, coupons, and config into locals with NO `await` anywhere, so it
 * observes a consistent snapshot without going through the executor. The HTTP
 * handler must perform no await between the builder's reads — it just calls
 * buildReport then replies.
 */

import type { Config } from "../config.js";
import type { Store } from "../store/store.js";
import type { Report } from "./types.js";

/** Build a fresh report snapshot. Synchronous, read-only, no mutation. */
export function buildReport(store: Store, config: Config): Report {
  const orders = [...store.orders.values()];
  const coupons = [...store.coupons.values()];

  // ordersPlaced derives from the order count (F2); every stored order is a
  // successfully placed order.
  const ordersPlaced = orders.length;
  const milestonesReached = Math.floor(ordersPlaced / config.n);

  const purchasedQuantityByProduct: Record<string, number> = {};
  let grossRevenueCents = 0;
  let totalDiscountsCents = 0;
  let netRevenueCents = 0;

  for (const order of orders) {
    grossRevenueCents += order.subtotalCents;
    totalDiscountsCents += order.discountCents;
    netRevenueCents += order.totalCents;
    for (const line of order.lines) {
      purchasedQuantityByProduct[line.productId] =
        (purchasedQuantityByProduct[line.productId] ?? 0) + line.quantity;
    }
  }

  let available = 0;
  let reserved = 0;
  let redeemed = 0;
  for (const coupon of coupons) {
    if (coupon.status === "available") available += 1;
    else if (coupon.status === "reserved") reserved += 1;
    else if (coupon.status === "redeemed") redeemed += 1;
  }

  return {
    ordersPlaced,
    milestonesReached,
    purchasedQuantityByProduct,
    grossRevenueCents,
    totalDiscountsCents,
    netRevenueCents,
    coupons: {
      generated: coupons.length,
      available,
      reserved,
      redeemed,
    },
    config: { n: config.n, x: config.x },
  };
}
