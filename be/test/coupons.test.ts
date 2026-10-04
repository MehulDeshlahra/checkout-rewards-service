import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/http/app.js";
import { seedProducts } from "../src/config.js";
import { createStore } from "../src/store/store.js";
import type { FastifyInstance } from "fastify";

/**
 * Coupon integration tests via app.inject(). Milestones are reached by placing
 * n real orders (each a fresh cart created through the API), then the admin
 * generate / list endpoints and the checkout discount path are exercised.
 */

const config = { n: 5, x: 10 };

function freshApp(): FastifyInstance {
  return buildApp({ store: createStore(seedProducts()), config });
}

async function placeOrder(
  app: FastifyInstance,
  productId: string,
  quantity: number,
): Promise<void> {
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
    payload: {},
  });
  expect(res.statusCode).toBe(201);
}

async function reachMilestone(app: FastifyInstance): Promise<void> {
  for (let i = 0; i < config.n; i += 1) {
    await placeOrder(app, "p_mug", 1);
  }
}

describe("coupons", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = freshApp();
  });

  it("generates a coupon at a reached milestone (201)", async () => {
    await reachMilestone(app);

    const res = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    expect(res.statusCode).toBe(201);
    const { coupon } = res.json();
    expect(coupon.code).toMatch(/^SAVE-[A-Z0-9]{6}$/);
    expect(coupon.percentOff).toBe(10);
    expect(coupon.milestone).toBe(5);
    expect(coupon.status).toBe("available");

    // GET /admin/coupons returns the status (NIT b).
    const list = await app.inject({ method: "GET", url: "/admin/coupons" });
    expect(list.statusCode).toBe(200);
    const coupons = list.json();
    expect(coupons).toHaveLength(1);
    expect(coupons[0]).toMatchObject({
      code: coupon.code,
      percentOff: 10,
      milestone: 5,
      status: "available",
    });
  });

  it("rejects a second generate for the same milestone with MILESTONE_ALREADY_REWARDED", async () => {
    await reachMilestone(app);
    const first = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("MILESTONE_ALREADY_REWARDED");
  });

  it("rejects generate before any milestone with NO_MILESTONE_REACHED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_MILESTONE_REACHED");
  });

  it("applies the discount and redeems the coupon on checkout", async () => {
    await reachMilestone(app);
    const gen = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    const code = gen.json().coupon.code as string;

    const cart = await app.inject({ method: "POST", url: "/carts" });
    const cartId = cart.json().id as string;
    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_coffee", quantity: 2 },
    });

    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: { couponCode: code },
    });
    expect(res.statusCode).toBe(201);
    const { order } = res.json();
    // subtotal 2598, 10% off -> round(259.8) = 260.
    expect(order.subtotalCents).toBe(2598);
    expect(order.discountCents).toBe(260);
    expect(order.totalCents).toBe(2338);
    expect(order.couponCode).toBe(code);

    // The coupon is now redeemed.
    const list = await app.inject({ method: "GET", url: "/admin/coupons" });
    const stored = list.json().find((c: { code: string }) => c.code === code);
    expect(stored.status).toBe("redeemed");
  });

  it("releases a reserved coupon when checkout fails on inventory (coupon survives)", async () => {
    await reachMilestone(app);
    const gen = await app.inject({
      method: "POST",
      url: "/admin/coupons/generate",
    });
    const code = gen.json().coupon.code as string;

    const cart = await app.inject({ method: "POST", url: "/carts" });
    const cartId = cart.json().id as string;
    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_limited", quantity: 5 }, // exceeds stock of 3
    });

    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: { couponCode: code },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_INVENTORY");

    // The coupon was reserved before inventory validation, so the release path
    // ran and the coupon is back to available.
    const list = await app.inject({ method: "GET", url: "/admin/coupons" });
    const stored = list.json().find((c: { code: string }) => c.code === code);
    expect(stored.status).toBe("available");
  });
});
