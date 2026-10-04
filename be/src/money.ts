/**
 * Money module (design Section 9).
 *
 * All monetary values are integer cents. No float ever enters the money path:
 * prices come from seed data (already cents) and quantities are integers. The
 * single non-integer step is the percentage division, immediately rounded.
 */

import { randomUUID } from "node:crypto";

/** Line subtotal = unit price (cents) * quantity. Integer x integer. */
export function lineSubtotal(unitPriceCents: number, quantity: number): number {
  return unitPriceCents * quantity;
}

/** Sum of integer cents amounts. */
export function sum(amounts: number[]): number {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
  }
  return total;
}

/**
 * Percentage discount in integer cents.
 *
 * discount = clamp(Math.round(subtotalCents * percentOff / 100), 0, subtotal)
 *
 * The division is the only non-integer step and is immediately rounded
 * half-up. Clamping to [0, subtotal] guarantees the order total can never go
 * negative, regardless of percentOff.
 */
export function percentDiscount(subtotalCents: number, percentOff: number): number {
  const raw = Math.round((subtotalCents * percentOff) / 100);
  if (raw < 0) return 0;
  if (raw > subtotalCents) return subtotalCents;
  return raw;
}

/** Format integer cents as a human-readable decimal string (e.g. 1299 -> "12.99"). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

/** Generate a new unique id using crypto.randomUUID (design finding F5). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
