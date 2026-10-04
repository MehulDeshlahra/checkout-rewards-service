import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/http/app.js";
import { seedProducts } from "../src/config.js";
import { createStore } from "../src/store/store.js";
import type { FastifyInstance } from "fastify";

/**
 * Checkout integration tests via app.inject(). Carts are created through the
 * API and their returned randomUUID ids captured (F5). The oversell /
 * concurrency case fires both checkouts without awaiting the first and relies
 * on the SerialExecutor's FIFO ordering for determinism (no setTimeout).
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

describe("checkout", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = freshApp();
  });

  it("checks out happily (201) with an order snapshot that explains itself", async () => {
    const cartId = await createCart(app);
    await addItem(app, cartId, "p_coffee", 2);

    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["idempotent-replay"]).toBeUndefined();

    const { order } = res.json();
    expect(order.cartId).toBe(cartId);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({
      productId: "p_coffee",
      name: "Bag of Coffee",
      unitPriceCents: 1299,
      quantity: 2,
      lineSubtotalCents: 2598,
    });
    expect(order.subtotalCents).toBe(2598);
    expect(order.discountCents).toBe(0);
    expect(order.totalCents).toBe(2598);
    expect(order.couponCode).toBeNull();
    expect(order.milestoneSequence).toBe(1);

    // The order is retrievable and read-only.
    const got = await app.inject({ method: "GET", url: `/orders/${order.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().order.id).toBe(order.id);
  });

  it("rejects an empty cart with 422 CART_EMPTY", async () => {
    const cartId = await createCart(app);
    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("CART_EMPTY");
  });

  it("rejects insufficient inventory with 409 INSUFFICIENT_INVENTORY", async () => {
    const cartId = await createCart(app);
    await addItem(app, cartId, "p_limited", 5); // stock is 3

    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_INVENTORY");

    // The cart stays open so the client can adjust.
    const cart = await app.inject({ method: "GET", url: `/carts/${cartId}` });
    expect(cart.json().status).toBe("open");
  });

  it("prevents oversell under concurrency: one 201, one 409, inventory lands at 1", async () => {
    const cartA = await createCart(app);
    const cartB = await createCart(app);
    await addItem(app, cartA, "p_limited", 2);
    await addItem(app, cartB, "p_limited", 2);

    // Fire both WITHOUT awaiting the first — FIFO serialization decides.
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

    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const failing = r1.statusCode === 409 ? r1 : r2;
    expect(failing.json().error.code).toBe("INSUFFICIENT_INVENTORY");

    const product = await app.inject({ method: "GET", url: "/products/p_limited" });
    expect(product.json().product.inventory).toBe(1);
  });

  it("replays a same-key retry: one order, second call 200 with Idempotent-Replay", async () => {
    const cartId = await createCart(app);
    await addItem(app, cartId, "p_coffee", 1);

    const first = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "ik_abc" },
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    const orderId = first.json().order.id;

    const second = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "ik_abc" },
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.json().order.id).toBe(orderId);

    // Only one order exists.
    const report = await app.inject({ method: "GET", url: "/admin/report" });
    expect(report.json().ordersPlaced).toBe(1);
  });

  it("rejects a reused key with different params: 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const cartA = await createCart(app);
    const cartB = await createCart(app);
    await addItem(app, cartA, "p_coffee", 1);
    await addItem(app, cartB, "p_mug", 1);

    const first = await app.inject({
      method: "POST",
      url: `/carts/${cartA}/checkout`,
      headers: { "idempotency-key": "ik_shared" },
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    const reused = await app.inject({
      method: "POST",
      url: `/carts/${cartB}/checkout`,
      headers: { "idempotency-key": "ik_shared" },
      payload: {},
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("header-less retry on a checked-out cart: same coupon replays, different coupon 409", async () => {
    const cartId = await createCart(app);
    await addItem(app, cartId, "p_coffee", 1);

    const first = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    // Same (no) coupon -> 200 replay.
    const sameReplay = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: {},
    });
    expect(sameReplay.statusCode).toBe(200);
    expect(sameReplay.headers["idempotent-replay"]).toBe("true");
    expect(sameReplay.json().order.id).toBe(first.json().order.id);

    // Different coupon -> 409 CART_ALREADY_CHECKED_OUT (contradictory resubmit).
    const different = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/checkout`,
      payload: { couponCode: "SAVE-ABCDEF" },
    });
    expect(different.statusCode).toBe(409);
    expect(different.json().error.code).toBe("CART_ALREADY_CHECKED_OUT");
  });
});
