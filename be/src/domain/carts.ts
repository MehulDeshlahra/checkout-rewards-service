/**
 * Carts service (design Sections 5.2, 6).
 *
 * All mutating cart operations run through the SerialExecutor (one at a time
 * against the store) and require the cart to be `open`. Cart lines store only
 * `{ productId, quantity }`; prices are computed live on view and captured
 * fresh at checkout (design Section 6.2). View does NOT apply any coupon.
 */

import { AppError } from "../errors.js";
import { lineSubtotal, newId, sum } from "../money.js";
import type { Store } from "../store/store.js";
import type { SerialExecutor } from "../store/executor.js";
import type { Cart } from "./types.js";

/** Maximum per-line quantity (sanity cap, design Section 5.2). */
const QUANTITY_CAP = 10000;

/** A cart view line decorated with the current price and subtotal. */
export interface CartViewLine {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineSubtotalCents: number;
}

/** The read model returned to clients for a cart (design Section 10). */
export interface CartView {
  id: string;
  status: Cart["status"];
  lines: CartViewLine[];
  subtotalCents: number;
}

/** Validate that a quantity is an integer in [1, QUANTITY_CAP]. */
function assertValidQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_CAP) {
    throw new AppError(
      "INVALID_QUANTITY",
      `quantity must be an integer between 1 and ${QUANTITY_CAP}`,
    );
  }
}

/** Load a cart or throw CART_NOT_FOUND (404). */
function loadCart(store: Store, cartId: string): Cart {
  const cart = store.carts.get(cartId);
  if (!cart) {
    throw new AppError("CART_NOT_FOUND", `cart '${cartId}' not found`);
  }
  return cart;
}

/** Require that a cart is still open, else CART_ALREADY_CHECKED_OUT (409). */
function assertOpen(cart: Cart): void {
  if (cart.status !== "open") {
    throw new AppError(
      "CART_ALREADY_CHECKED_OUT",
      `cart '${cart.id}' is already checked out`,
    );
  }
}

/** Require that a product exists, else PRODUCT_NOT_FOUND (404). */
function assertProductExists(store: Store, productId: string): void {
  if (!store.products.has(productId)) {
    throw new AppError("PRODUCT_NOT_FOUND", `product '${productId}' not found`);
  }
}

/**
 * Build a view of a cart decorated with current prices. Read-only; safe to
 * call off the executor (performs no await between reads).
 */
export function viewCart(store: Store, cart: Cart): CartView {
  const lines: CartViewLine[] = cart.lines.map((line) => {
    const product = store.products.get(line.productId);
    // A product could in principle be removed after being added; surface a
    // zero-price line rather than throwing on a read. Checkout is the point
    // that rejects a removed product (PRODUCT_UNAVAILABLE).
    const unitPriceCents = product?.priceCents ?? 0;
    const name = product?.name ?? line.productId;
    return {
      productId: line.productId,
      name,
      unitPriceCents,
      quantity: line.quantity,
      lineSubtotalCents: lineSubtotal(unitPriceCents, line.quantity),
    };
  });
  return {
    id: cart.id,
    status: cart.status,
    lines,
    subtotalCents: sum(lines.map((l) => l.lineSubtotalCents)),
  };
}

/** Read-only cart view by id (CART_NOT_FOUND if absent). */
export function getCartView(store: Store, cartId: string): CartView {
  return viewCart(store, loadCart(store, cartId));
}

/** Create a new empty open cart. Runs through the executor. */
export function createCart(store: Store, executor: SerialExecutor): Promise<CartView> {
  return executor.run(async () => {
    const now = new Date().toISOString();
    const cart: Cart = {
      id: newId("cart"),
      lines: [],
      status: "open",
      orderId: null,
      createdAt: now,
      updatedAt: now,
    };
    store.carts.set(cart.id, cart);
    return viewCart(store, cart);
  });
}

/**
 * Add an item to a cart. If the product already has a line, the quantities are
 * summed and re-validated against the cap; otherwise a new line is appended.
 */
export function addItem(
  store: Store,
  executor: SerialExecutor,
  cartId: string,
  productId: string,
  quantity: number,
): Promise<CartView> {
  return executor.run(async () => {
    const cart = loadCart(store, cartId);
    assertOpen(cart);
    assertProductExists(store, productId);
    assertValidQuantity(quantity);

    const existing = cart.lines.find((l) => l.productId === productId);
    if (existing) {
      const summed = existing.quantity + quantity;
      assertValidQuantity(summed);
      existing.quantity = summed;
    } else {
      cart.lines.push({ productId, quantity });
    }
    cart.updatedAt = new Date().toISOString();
    return viewCart(store, cart);
  });
}

/** Set the absolute quantity of an existing line (must be >= 1). */
export function updateQty(
  store: Store,
  executor: SerialExecutor,
  cartId: string,
  productId: string,
  quantity: number,
): Promise<CartView> {
  return executor.run(async () => {
    const cart = loadCart(store, cartId);
    assertOpen(cart);
    assertValidQuantity(quantity);

    const line = cart.lines.find((l) => l.productId === productId);
    if (!line) {
      throw new AppError(
        "LINE_NOT_FOUND",
        `cart '${cartId}' has no line for product '${productId}'`,
      );
    }
    line.quantity = quantity;
    cart.updatedAt = new Date().toISOString();
    return viewCart(store, cart);
  });
}

/**
 * Remove a line. Idempotent: removing an absent line is a no-op that returns
 * the current cart (200), not an error (design Section 6.1).
 */
export function removeItem(
  store: Store,
  executor: SerialExecutor,
  cartId: string,
  productId: string,
): Promise<CartView> {
  return executor.run(async () => {
    const cart = loadCart(store, cartId);
    assertOpen(cart);

    const idx = cart.lines.findIndex((l) => l.productId === productId);
    if (idx !== -1) {
      cart.lines.splice(idx, 1);
      cart.updatedAt = new Date().toISOString();
    }
    return viewCart(store, cart);
  });
}
