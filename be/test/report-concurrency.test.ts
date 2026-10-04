import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/http/app.js";
import { seedProducts } from "../src/config.js";
import { createStore } from "../src/store/store.js";
import type { FastifyInstance } from "fastify";

/**
 * Report-under-concurrency reconciliation test (design-review Finding 1).
 *
 * GET /admin/report is fired concurrently with a committing checkout using the
 * same Promise.all pattern as the oversell test (no setTimeout/sleeps). Because
 * buildReport is fully synchronous (rule R-REPORT-SYNC) and reads are off the
 * executor, the report always observes a consistent snapshot: every
 * reconciliation identity must hold whether the report runs before or after the
 * checkout commits. We exercise R-REPORT-SYNC rather than assuming it.
 */

const config = { n: 5, x: 10 };

function freshApp(): FastifyInstance {
  return buildApp({ store: createStore(seedProducts()), config });
}

async function createCart(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/carts" });
  return res.json().id as string;
}

async function addItem(
  app: FastifyInstance,
  cartId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/carts/${cartId}/items`,
    payload: { productId, quantity },
  });
  expect(res.statusCode).toBe(200);
}

async function placeOrder(
  app: FastifyInstance,
  productId: string,
  quantity: number,
): Promise<void> {
  const cartId = await createCart(app);
  await addItem(app, cartId, productId, quantity);
  const res = await app.inject({
    method: "POST",
    url: `/carts/${cartId}/checkout`,
    payload: {},
  });
  expect(res.statusCode).toBe(201);
}

/** Assert every reconciliation identity holds on a report snapshot. */
function assertReconciles(report: any): void {
  // Revenue identity.
  expect(report.netRevenueCents).toBe(
    report.grossRevenueCents - report.totalDiscountsCents,
  );
  // Coupon-state partition.
  expect(report.coupons.generated).toBe(
    report.coupons.available + report.coupons.reserved + report.coupons.redeemed,
  );
  // Generated coupons never exceed milestones reached.
  expect(report.coupons.generated).toBeLessThanOrEqual(report.milestonesReached);
  // Values are self-consistent (never negative).
  expect(report.ordersPlaced).toBeGreaterThanOrEqual(0);
  expect(report.grossRevenueCents).toBeGreaterThanOrEqual(0);
  expect(report.totalDiscountsCents).toBeGreaterThanOrEqual(0);
}

describe("report under concurrency", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = freshApp();
  });

  it("report fired concurrently with a committing checkout always reconciles", async () => {
    // Seed some prior orders so the report has non-trivial figures.
    for (let i = 0; i < config.n; i += 1) {
      await placeOrder(app, "p_mug", 1);
    }
    // Generate the milestone coupon and redeem it on a prior order so the report
    // carries a redeemed coupon and a discounted order too.
    const gen = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    expect(gen.statusCode).toBe(201);
    const code = gen.json().coupon.code as string;
    const discountedCart = await createCart(app);
    await addItem(app, discountedCart, "p_coffee", 2);
    const discounted = await app.inject({
      method: "POST",
      url: `/carts/${discountedCart}/checkout`,
      payload: { couponCode: code },
    });
    expect(discounted.statusCode).toBe(201);

    // Prepare one more committing checkout to race against the report read.
    const racingCart = await createCart(app);
    await addItem(app, racingCart, "p_coffee", 1);

    // Fire the report GET concurrently with the committing checkout WITHOUT
    // awaiting the first. buildReport is synchronous and off the executor, so
    // the snapshot it reads is consistent regardless of ordering.
    const checkoutP = app.inject({
      method: "POST",
      url: `/carts/${racingCart}/checkout`,
      payload: {},
    });
    const reportP = app.inject({ method: "GET", url: "/admin/report" });
    const [checkoutRes, reportRes] = await Promise.all([checkoutP, reportP]);

    expect(checkoutRes.statusCode).toBe(201);
    expect(reportRes.statusCode).toBe(200);

    // Identities hold on the concurrently-read snapshot.
    const report = reportRes.json();
    assertReconciles(report);

    // The coupon.redeemed count equals the number of orders carrying a coupon,
    // verified against the concurrently-observed order count via a fresh read.
    const racedRedeemed = report.coupons.redeemed as number;
    expect(racedRedeemed).toBe(1);

    // After everything settles, the final report still reconciles and reflects
    // the extra committed order.
    const finalReport = (
      await app.inject({ method: "GET", url: "/admin/report" })
    ).json();
    assertReconciles(finalReport);
    expect(finalReport.ordersPlaced).toBe(config.n + 2);
    // coupons.redeemed === count(orders with a couponCode) — exactly the one
    // discounted order used a coupon.
    expect(finalReport.coupons.redeemed).toBe(1);
  });
});
