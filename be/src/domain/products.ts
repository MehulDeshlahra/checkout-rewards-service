/**
 * Products service (design Section 5).
 *
 * Read-only operations over the in-memory store. Inventory is only ever
 * mutated by checkout; there is no public price/inventory mutation endpoint.
 */

import { AppError } from "../errors.js";
import type { Store } from "../store/store.js";
import type { Product } from "./types.js";

/** List all products with current price and inventory. Read-only. */
export function listProducts(store: Store): Product[] {
  return [...store.products.values()].map((p) => ({ ...p }));
}

/** Get a single product by id, or throw PRODUCT_NOT_FOUND (404). Read-only. */
export function getProduct(store: Store, id: string): Product {
  const product = store.products.get(id);
  if (!product) {
    throw new AppError("PRODUCT_NOT_FOUND", `product '${id}' not found`);
  }
  return { ...product };
}
