/**
 * Domain model types for the checkout + rewards service.
 *
 * All monetary values are integer cents (never floats). See design Section 3.
 */

/** A sellable product with current price and available inventory. */
export interface Product {
  id: string;
  name: string;
  /** Current unit price in integer cents, >= 0. */
  priceCents: number;
  /** Available units, integer >= 0. */
  inventory: number;
}

/**
 * A line in a cart. Prices are NOT stored on the line; they are computed on
 * view and captured fresh at checkout (design Section 6).
 */
export interface CartLine {
  productId: string;
  /** Integer >= 1. */
  quantity: number;
}

export type CartStatus = "open" | "checked_out";

export interface Cart {
  id: string;
  lines: CartLine[];
  status: CartStatus;
  /** Set when the cart is checked out. */
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An immutable line snapshot captured on the order at checkout time. */
export interface OrderLine {
  productId: string;
  /** Product name at time of purchase (snapshot). */
  name: string;
  /** Unit price at time of purchase, integer cents (snapshot). */
  unitPriceCents: number;
  quantity: number;
  /** unitPriceCents * quantity. */
  lineSubtotalCents: number;
}

/** An immutable order snapshot created by a committed checkout. */
export interface Order {
  id: string;
  cartId: string;
  lines: OrderLine[];
  /** Sum of line subtotals, pre-discount. */
  subtotalCents: number;
  /** Discount applied, >= 0. */
  discountCents: number;
  /** subtotal - discount, guaranteed >= 0. */
  totalCents: number;
  couponCode: string | null;
  createdAt: string;
  /**
   * This order's 1-based position in the sequence of successfully placed
   * orders. Drives coupon milestones. Equals orders.size right after insert
   * (design finding F2).
   */
  milestoneSequence: number;
}

export type CouponStatus = "available" | "reserved" | "redeemed";

/**
 * A discount coupon rewarded at a milestone.
 *
 * Per design finding F4 there is intentionally NO `reservedBy` field: in a
 * single-process in-memory store the reservation lives only for the duration
 * of one serialized executor task, so no persistent holder id is needed. The
 * multi-instance DB design would reintroduce such a column (see DECISIONS.md).
 */
export interface Coupon {
  code: string;
  /** Percent off (= configured `x`). */
  percentOff: number;
  /** The order-count milestone this coupon rewards (e.g. 5, 10, 15). */
  milestone: number;
  status: CouponStatus;
  /** Set to the order id when the coupon is redeemed. */
  redeemedByOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Idempotency record, keyed by the Idempotency-Key header value and scoped to
 * checkout. Written only on a committed checkout (design Section 3): there is
 * no `in_progress` state.
 */
export interface IdempotencyRecord {
  key: string;
  cartId: string;
  /** Plain delimiter-joined string `${cartId}|${couponCode ?? ""}` (F3). */
  requestFingerprint: string;
  status: "completed";
  /** The committed order id. */
  orderId: string;
  /** The order body to replay (identical to the original 201 body). */
  responseBody: unknown;
}

/** The read-only admin report shape (design Section 12). */
export interface Report {
  ordersPlaced: number;
  milestonesReached: number;
  purchasedQuantityByProduct: Record<string, number>;
  grossRevenueCents: number;
  totalDiscountsCents: number;
  netRevenueCents: number;
  coupons: {
    generated: number;
    available: number;
    reserved: number;
    redeemed: number;
  };
  config: {
    n: number;
    x: number;
  };
}
