/**
 * Coupons service (design Section 8).
 *
 * Coupon codes match ^SAVE-[A-Z0-9]{6}$ and are globally unique. Generation is
 * admin-driven and idempotent at the milestone level (generatedMilestones is
 * the single source of truth for invariant I4). The reserve/release/redeem
 * helpers implement the available -> reserved -> redeemed state machine with
 * NO `reservedBy` field (design finding F4); checkout drives these transitions
 * inside a single executor task.
 */

import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import type { Config } from "../config.js";
import type { Store } from "../store/store.js";
import type { SerialExecutor } from "../store/executor.js";
import type { Coupon } from "./types.js";

/** Crockford-style base32 alphabet used for the 6-char code suffix. */
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Generate a code matching ^SAVE-[A-Z0-9]{6}$ from crypto.randomBytes. */
export function genCode(): string {
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return `SAVE-${suffix}`;
}

/** Generate a code that does not collide with any existing coupon. */
function genUniqueCode(store: Store): string {
  let code = genCode();
  while (store.coupons.has(code)) {
    code = genCode();
  }
  return code;
}

/** The admin coupon list shape (design Section 10, NIT b: includes status). */
export interface CouponSummary {
  code: string;
  percentOff: number;
  milestone: number;
  status: Coupon["status"];
}

/** List all coupons as summaries. Read-only. */
export function listCoupons(store: Store): CouponSummary[] {
  return [...store.coupons.values()].map((c) => ({
    code: c.code,
    percentOff: c.percentOff,
    milestone: c.milestone,
    status: c.status,
  }));
}

/**
 * Generate a coupon for the largest reached-but-unrewarded milestone. Runs
 * through the executor (invariant I4).
 *
 * eligibleMilestone = floor(orders.size / n) * n (orders.size per F2):
 *   - 0                                -> NO_MILESTONE_REACHED (409)
 *   - already in generatedMilestones   -> MILESTONE_ALREADY_REWARDED (409)
 *   - else create an `available` coupon and record the milestone.
 */
export function generateCoupon(
  store: Store,
  executor: SerialExecutor,
  config: Config,
): Promise<Coupon> {
  return executor.run(async () => {
    const ordersPlaced = store.orders.size;
    const eligibleMilestone = Math.floor(ordersPlaced / config.n) * config.n;

    if (eligibleMilestone === 0) {
      throw new AppError(
        "NO_MILESTONE_REACHED",
        "no reward milestone has been reached yet",
      );
    }
    if (store.generatedMilestones.has(eligibleMilestone)) {
      throw new AppError(
        "MILESTONE_ALREADY_REWARDED",
        `milestone ${eligibleMilestone} has already been rewarded`,
      );
    }

    const now = new Date().toISOString();
    const coupon: Coupon = {
      code: genUniqueCode(store),
      percentOff: config.x,
      milestone: eligibleMilestone,
      status: "available",
      redeemedByOrderId: null,
      createdAt: now,
      updatedAt: now,
    };
    store.coupons.set(coupon.code, coupon);
    store.generatedMilestones.add(eligibleMilestone);
    return { ...coupon };
  });
}

// --- State-machine helpers (called INSIDE the checkout executor task) ---

/**
 * Reserve a coupon for a checkout attempt: available -> reserved.
 *   - missing              -> COUPON_NOT_FOUND (422)
 *   - status != available  -> COUPON_NOT_REDEEMABLE (409)
 * Returns the reserved coupon. No `reservedBy` is recorded (F4).
 */
export function reserveCoupon(store: Store, code: string): Coupon {
  const coupon = store.coupons.get(code);
  if (!coupon) {
    throw new AppError("COUPON_NOT_FOUND", `coupon '${code}' not found`);
  }
  if (coupon.status !== "available") {
    throw new AppError(
      "COUPON_NOT_REDEEMABLE",
      `coupon '${code}' is not redeemable`,
    );
  }
  coupon.status = "reserved";
  coupon.updatedAt = new Date().toISOString();
  return coupon;
}

/** Release a reserved coupon back to available (compensation on failure). */
export function releaseCoupon(coupon: Coupon): void {
  coupon.status = "available";
  coupon.redeemedByOrderId = null;
  coupon.updatedAt = new Date().toISOString();
}

/** Redeem a reserved coupon on commit: reserved -> redeemed. */
export function redeemCoupon(coupon: Coupon, orderId: string): void {
  coupon.status = "redeemed";
  coupon.redeemedByOrderId = orderId;
  coupon.updatedAt = new Date().toISOString();
}
