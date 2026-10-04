/**
 * In-memory store (design Sections 2, 3).
 *
 * Plain JS Maps hold all mutable state. All mutating access to this store must
 * go through the SerialExecutor (design Section 4); reads are synchronous
 * snapshot builders off the executor. The test-only setters at the bottom let
 * failure tests simulate product price/inventory changes without exposing an
 * unrequired admin mutation API (design Section 5.2).
 */

import type {
  Cart,
  Coupon,
  IdempotencyRecord,
  Order,
  Product,
} from "../domain/types.js";

export interface Store {
  products: Map<string, Product>;
  carts: Map<string, Cart>;
  orders: Map<string, Order>;
  coupons: Map<string, Coupon>;
  idempotency: Map<string, IdempotencyRecord>;
  /** Milestones that have already had a coupon generated (invariant I4). */
  generatedMilestones: Set<number>;

  // --- Test-only setters (design Section 5.2) ---
  /** Set a product's current price. Used by "price changed since add" tests. */
  setProductPrice(productId: string, priceCents: number): void;
  /** Adjust a product's inventory by a (possibly negative) delta. */
  adjustInventory(productId: string, delta: number): void;
  /** Remove a product entirely. Used by PRODUCT_UNAVAILABLE tests. */
  removeProduct(productId: string): void;
}

/** Create a fresh, empty store seeded with the provided products. */
export function createStore(seedProducts: Product[]): Store {
  const products = new Map<string, Product>();
  for (const p of seedProducts) {
    // Clone so the seed array is not aliased into mutable store state.
    products.set(p.id, { ...p });
  }

  const store: Store = {
    products,
    carts: new Map<string, Cart>(),
    orders: new Map<string, Order>(),
    coupons: new Map<string, Coupon>(),
    idempotency: new Map<string, IdempotencyRecord>(),
    generatedMilestones: new Set<number>(),

    setProductPrice(productId, priceCents) {
      const product = products.get(productId);
      if (product) {
        product.priceCents = priceCents;
      }
    },

    adjustInventory(productId, delta) {
      const product = products.get(productId);
      if (product) {
        product.inventory += delta;
      }
    },

    removeProduct(productId) {
      products.delete(productId);
    },
  };

  return store;
}
