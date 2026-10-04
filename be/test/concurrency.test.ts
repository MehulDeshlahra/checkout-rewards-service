import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/http/app.js";
import { seedProducts } from "../src/config.js";
import { createStore } from "../src/store/store.js";
import type { FastifyInstance } from "fastify";

/**
 * Deterministic concurrency + failure-mode suite (design Sections 4.2, 13, 14).
 *
 * Determinism comes ONLY from the SerialExecutor's FIFO ordering: competing
 * mutations are submitted via app.inject WITHOUT awaiting the first, then
 * resolved together with Promise.all. There are NO setTimeout/sleeps anywhere.
 * Carts are created through the API and their returned randomUUID ids captured;
 * assertions are on counts and final inventory, never on which specific cart
 * wins the race.
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

/** Reach a milestone (n orders) so a coupon can be generated. */
async function reachMilestoneAndGenerate(app: FastifyInstance): Promise<string> {
  for (let i = 0; i < config.n; i += 1) {
    await placeOrder(app, "p_mug", 1);
  }
  const gen = await app.inject({
    method: "POST",
    url: "/admin/coupons/generate",
  });
  expect(gen.statusCode).toBe(201);
  return gen.json().coupon.code as string;
}

describe("concurrency and failure modes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = freshApp();
  });

  it("oversell: two checkouts race the last units — one 201, one 409, inventory lands at 1 and never negative", async () => {
    // p_limited stock is 3; two carts each want 2 (total 4 > 3).
    const cartA = await createCart(app);
    const cartB = await createCart(app);
    await addItem(app, cartA, "p_limited", 2);
    await addItem(app, cartB, "p_limited", 2);

    // Fire both WITHOUT awaiting the first — FIFO serialization alone decides.
    const p1 = app.inject({
      method: "POST",
      url: `/carts/${cartA}/checkout`,
      payload: {},
    });
    const p2 = app.inject({
      method: "POST",
      url: `/carts/${cartB}/checkout`,
      payload: {},
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one 201 and one 409, regardless of which cart won.
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const failing = r1.statusCode === 409 ? r1 : r2;
    expect(failing.json().error.code).toBe("INSUFFICIENT_INVENTORY");

    // Final inventory is deterministically 1 and was never driven negative.
    const product = await app.inject({ method: "GET", url: "/products/p_limited" });
    const inventory = product.json().product.inventory as number;
    expect(inventory).toBe(1);
    expect(inventory).toBeGreaterThanOrEqual(0);

    // Exactly one order was placed.
    const report = (await app.inject({ method: "GET", url: "/admin/report" })).json();
    expect(report.ordersPlaced).toBe(1);
  });

  it("coupon race: two checkouts both supply one single-use coupon — one 201, one 409, redeemed exactly once", async () => {
    const code = await reachMilestoneAndGenerate(app);

    const cartA = await createCart(app);
    const cartB = await createCart(app);
    await addItem(app, cartA, "p_coffee", 1);
    await addItem(app, cartB, "p_mug", 1);

    // Both checkouts carry the same coupon; FIFO serialization decides.
    const p1 = app.inject({
      method: "POST",
      url: `/carts/${cartA}/checkout`,
      payload: { couponCode: code },
    });
    const p2 = app.inject({
      method: "POST",
      url: `/carts/${cartB}/checkout`,
      payload: { couponCode: code },
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const failing = r1.statusCode === 409 ? r1 : r2;
    expect(failing.json().error.code).toBe("COUPON_NOT_REDEEMABLE");

    // The coupon shows as redeemed exactly once in the admin list.
    const list = (await app.inject({ method: "GET", url: "/admin/coupons" })).json();
    const redeemed = list.filter(
      (c: { code: string; status: string }) =>
        c.code === code && c.status === "redeemed",
    );
    expect(redeemed).toHaveLength(1);

    // And the report agrees: exactly one redemption.
    const report = (await app.inject({ method: "GET", url: "/admin/report" })).json();
    expect(report.coupons.redeemed).toBe(1);
  });

  it("coupon survives a failed checkout: inventory failure releases the reservation back to available", async () => {
    const code = await reachMilestoneAndGenerate(app);

    const cartId = await createCart(app);
    await addItem(app, cartId, "p_limited", 5); // exceeds stock of 3

    // Coupon is reserved BEFORE inventory validation, so the release path runs.
    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: { couponCode: code },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_INVENTORY");

    // The coupon is back to available (not lost or consumed by a failed checkout).
    const list = (await app.inject({ method: "GET", url: "/admin/coupons" })).json();
    const stored = list.find((c: { code: string }) => c.code === code);
    expect(stored.status).toBe("available");

    // The report reflects it as available, with zero redeemed.
    const report = (await app.inject({ method: "GET", url: "/admin/report" })).json();
    expect(report.coupons.available).toBe(1);
    expect(report.coupons.redeemed).toBe(0);
  });
});
