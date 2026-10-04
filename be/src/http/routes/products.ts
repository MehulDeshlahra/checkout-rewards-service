/**
 * Product routes (design Section 10): read-only.
 *   GET /products
 *   GET /products/:id
 */

import { getProduct, listProducts } from "../../domain/products.js";
import type { FastifyInstance } from "fastify";
import type { Store } from "../../store/store.js";

export function registerProductRoutes(app: FastifyInstance, store: Store): void {
  app.get("/products", async () => {
    return listProducts(store);
  });

  app.get<{ Params: { id: string } }>("/products/:id", async (req) => {
    return { product: getProduct(store, req.params.id) };
  });
}
