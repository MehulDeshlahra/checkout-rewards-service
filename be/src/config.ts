/**
 * Configuration + seed data (design Sections 5.1, 8).
 *
 * loadConfig(env) validates the reward config with a zod schema and FAILS FAST
 * (throws a plain Error with a clear message) before the server ever listens,
 * so the service never runs with invalid reward config:
 *   - n must be an integer >= 1 (0 would divide-by-zero in floor(count/n))
 *   - x must be an integer in [0, 100]
 * Defaults: n = 5, x = 10.
 */

import { z } from "zod";
import type { Product } from "./domain/types.js";

export interface Config {
  /** Milestone interval: every nth placed order makes a coupon available. */
  n: number;
  /** Percent off granted by a generated coupon. */
  x: number;
}

const DEFAULT_N = 5;
const DEFAULT_X = 10;

/** Seed products (design Section 5.1): >= 5 products, including p_limited (stock 3). */
export const SEED_PRODUCTS: Product[] = [
  { id: "p_coffee", name: "Bag of Coffee", priceCents: 1299, inventory: 100 },
  { id: "p_mug", name: "Ceramic Mug", priceCents: 850, inventory: 100 },
  { id: "p_grinder", name: "Burr Grinder", priceCents: 7499, inventory: 100 },
  { id: "p_filters", name: "Paper Filters (100ct)", priceCents: 599, inventory: 100 },
  { id: "p_scale", name: "Precision Scale", priceCents: 3250, inventory: 100 },
  { id: "p_limited", name: "Limited Edition Tin", priceCents: 2500, inventory: 3 },
];

/** Return a fresh copy of the seed products (never share mutable state). */
export function seedProducts(): Product[] {
  return SEED_PRODUCTS.map((p) => ({ ...p }));
}

/**
 * Coerce an env string to an integer, keeping non-integer / non-numeric inputs
 * distinguishable so the zod schema can reject them with a clear message.
 * Returns NaN for anything that is not a clean base-10 integer string.
 */
function toIntOrNaN(raw: string): number {
  // Reject values like "5.5", "1e3", "abc", " 5 " that Number() would accept
  // or that are not clean integers. Only an optional sign + digits is valid.
  if (!/^-?\d+$/.test(raw.trim())) {
    return Number.NaN;
  }
  return Number.parseInt(raw.trim(), 10);
}

const nSchema = z
  .number()
  .int()
  .min(1, { message: "expected integer >= 1" });

const xSchema = z
  .number()
  .int()
  .min(0, { message: "expected integer in [0, 100]" })
  .max(100, { message: "expected integer in [0, 100]" });

/**
 * Load and validate reward config from an environment-like object. Throws a
 * plain Error (fail-fast) on any violation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawN = env.REWARD_N;
  const rawX = env.REWARD_X;

  const n = rawN === undefined || rawN === "" ? DEFAULT_N : toIntOrNaN(rawN);
  const x = rawX === undefined || rawX === "" ? DEFAULT_X : toIntOrNaN(rawX);

  const nResult = nSchema.safeParse(n);
  if (!nResult.success) {
    throw new Error(
      `invalid REWARD_N: expected integer >= 1, got '${rawN ?? ""}'`,
    );
  }

  const xResult = xSchema.safeParse(x);
  if (!xResult.success) {
    throw new Error(
      `invalid REWARD_X: expected integer in [0, 100], got '${rawX ?? ""}'`,
    );
  }

  return { n: nResult.data, x: xResult.data };
}
