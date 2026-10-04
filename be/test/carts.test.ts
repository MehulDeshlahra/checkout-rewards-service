import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/http/app.js";
import { seedProducts } from "../src/config.js";
import { createStore } from "../src/store/store.js";
import type { FastifyInstance } from "fastify";

/**
 * Cart integration tests via app.inject() (no sockets). Each test builds a
 * fresh app over a fresh store, creates carts via the API, and captures the
 * returned crypto.randomUUID ids (design finding F5) — never literal fixtures.
 */

const config = { n: 5, x: 10 };

function freshApp(): FastifyInstance {
  return buildApp({ store: createStore(seedProducts()), config });
}

async function createCart(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/carts" });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.status).toBe("open");
  expect(body.lines).toEqual([]);
  return body.id as string;
}

describe("carts", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = freshApp();
  });

  it("adds items and computes line + cart subtotals from current prices", async () => {
    const cartId = await createCart(app);

    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_coffee", quantity: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({
      productId: "p_coffee",
      name: "Bag of Coffee",
      unitPriceCents: 1299,
      quantity: 2,
      lineSubtotalCents: 2598,
    });
    expect(body.subtotalCents).toBe(2598);
  });

  it("sums quantities when the same product is added twice", async () => {
    const cartId = await createCart(app);

    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_mug", quantity: 1 },
    });
    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_mug", quantity: 3 },
    });
    const body = res.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].quantity).toBe(4);
    expect(body.lines[0].lineSubtotalCents).toBe(850 * 4);
    expect(body.subtotalCents).toBe(850 * 4);
  });

  it("updates a line to an absolute quantity", async () => {
    const cartId = await createCart(app);
    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_mug", quantity: 5 },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/carts/${cartId}/items/p_mug`,
      payload: { quantity: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines[0].quantity).toBe(2);
  });

  it("removes a line and is idempotent on an absent line", async () => {
    const cartId = await createCart(app);
    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_mug", quantity: 1 },
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/carts/${cartId}/items/p_mug`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().lines).toHaveLength(0);

    // Removing again (absent line) is a no-op 200, not an error.
    const again = await app.inject({
      method: "DELETE",
      url: `/carts/${cartId}/items/p_mug`,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().lines).toHaveLength(0);
  });

  it("views a cart with multiple lines and a reconciling subtotal", async () => {
    const cartId = await createCart(app);
    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_coffee", quantity: 2 },
    });
    await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_filters", quantity: 3 },
    });

    const res = await app.inject({ method: "GET", url: `/carts/${cartId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const expected = 1299 * 2 + 599 * 3;
    expect(body.subtotalCents).toBe(expected);
    const summed = body.lines.reduce(
      (acc: number, l: { lineSubtotalCents: number }) => acc + l.lineSubtotalCents,
      0,
    );
    expect(summed).toBe(expected);
  });

  it("rejects adding an unknown product with 404 PRODUCT_NOT_FOUND", async () => {
    const cartId = await createCart(app);
    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_nope", quantity: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("rejects an invalid quantity with 400 INVALID_QUANTITY", async () => {
    const cartId = await createCart(app);
    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_coffee", quantity: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_QUANTITY");
  });

  it("rejects a malformed body with 400 VALIDATION_ERROR", async () => {
    const cartId = await createCart(app);
    const res = await app.inject({
      method: "POST",
      url: `/carts/${cartId}/items`,
      payload: { productId: "p_coffee" }, // missing quantity
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 CART_NOT_FOUND for an unknown cart", async () => {
    const res = await app.inject({ method: "GET", url: "/carts/cart_missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("CART_NOT_FOUND");
  });
});
