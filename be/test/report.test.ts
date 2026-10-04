import { describe, it, expect } from "vitest";
import { buildApp } from "../src/http/app.js";
import { seedProducts } from "../src/config.js";
import { createStore } from "../src/store/store.js";
import type { FastifyInstance } from "fastify";

/**
 * Report reconciliation tests via app.inject(). Several orders are placed
 * (including a discounted one) and the report's I5 identities are asserted
 * against independently summed order data (design Section 12/14).
 */

const config = { n: 5, x: 10 };

function freshApp(): FastifyInstance {
  return buildApp({ store: createStore(seedProducts()), config });
}

async function placeOrder(
  app: FastifyInstance,
  productId: string,
  quantity: number,
  couponCode?: string,
): Promise<{ id: string; subtotalCents: number; discountCents: number; totalCents: number }> {
  const cart = await app.inject({ method: "POST", url: "/carts" });
  const cartId = cart.json().id as string;
  await app.inject({
    method: "POST",
    url: `/carts/${cartId}/items`,
    payload: { productId, quantity },
  });
  const res = await app.inject({
    method: "POST",
    url: `/carts/${cartId}/checkout`,
    payload: couponCode ? { couponCode } : {},
  });
  expect(res.statusCode).toBe(201);
  return res.json().order;
}

describe("report", () => {
  it("reconciles revenue and coupon identities after several orders", async () => {
    const app = freshApp();

    // Place 5 plain orders to reach milestone 5, summing expected revenue.
    let gross = 0;
    let discounts = 0;
    for (let i = 0; i < 5; i += 1) {
      const o = await placeOrder(app, "p_mug", 1);
      gross += o.subtotalCents;
      discounts += o.discountCents;
    }

    // Generate the milestone coupon and place a discounted order.
    const gen = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    const code = gen.json().coupon.code as string;
    const discounted = await placeOrder(app, "p_coffee", 2, code);
    gross += discounted.subtotalCents;
    discounts += discounted.discountCents;

    const report = (await app.inject({ method: "GET", url: "/admin/report" })).json();

    // Independently derived figures.
    expect(report.ordersPlaced).toBe(6);
    expect(report.milestonesReached).toBe(Math.floor(6 / config.n));
    expect(report.grossRevenueCents).toBe(gross);
    expect(report.totalDiscountsCents).toBe(discounts);

    // Reconciliation identities (I5).
    expect(report.netRevenueCents).toBe(
      report.grossRevenueCents - report.totalDiscountsCents,
    );
    expect(report.coupons.generated).toBe(
      report.coupons.available + report.coupons.reserved + report.coupons.redeemed,
    );
    expect(report.coupons.redeemed).toBe(1); // exactly one order used a coupon
    expect(report.coupons.generated).toBeLessThanOrEqual(report.milestonesReached);

    // Purchased quantities group by product.
    expect(report.purchasedQuantityByProduct.p_mug).toBe(5);
    expect(report.purchasedQuantityByProduct.p_coffee).toBe(2);

    // Config echoes the injected values.
    expect(report.config).toEqual({ n: 5, x: 10 });
  });

  it("reports zeros for a fresh store", async () => {
    const app = freshApp();
    const report = (await app.inject({ method: "GET", url: "/admin/report" })).json();
    expect(report.ordersPlaced).toBe(0);
    expect(report.grossRevenueCents).toBe(0);
    expect(report.netRevenueCents).toBe(0);
    expect(report.coupons).toEqual({ generated: 0, available: 0, reserved: 0, redeemed: 0 });
  });
});
