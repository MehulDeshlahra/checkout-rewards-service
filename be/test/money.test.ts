import { describe, it, expect } from "vitest";
import {
  lineSubtotal,
  sum,
  percentDiscount,
  formatCents,
  newId,
} from "../src/money.js";

describe("money", () => {
  describe("lineSubtotal", () => {
    it("multiplies unit price cents by quantity (integer math)", () => {
      expect(lineSubtotal(1299, 2)).toBe(2598);
      expect(lineSubtotal(599, 3)).toBe(1797);
      expect(lineSubtotal(0, 5)).toBe(0);
    });
  });

  describe("sum", () => {
    it("sums integer cents amounts", () => {
      expect(sum([2598, 1797, 0])).toBe(4395);
      expect(sum([])).toBe(0);
    });
  });

  describe("percentDiscount", () => {
    it("rounds half-up: 1299 * 10 / 100 -> round(129.9) = 130", () => {
      expect(percentDiscount(1299, 10)).toBe(130);
    });

    it("rounds half-up at the .5 boundary", () => {
      // 2510 * 10 / 100 = 251.0 -> 251; craft an exact .5: 5 * 50 / 100 = 2.5 -> 3
      expect(percentDiscount(5, 50)).toBe(3);
    });

    it("clamps discount to the subtotal so total is never negative", () => {
      // percentOff >= 100 would meet-or-exceed subtotal; discount == subtotal.
      expect(percentDiscount(2598, 100)).toBe(2598);
      expect(percentDiscount(2598, 150)).toBe(2598);
      // total = subtotal - discount is therefore >= 0
      expect(2598 - percentDiscount(2598, 150)).toBe(0);
    });

    it("returns 0 for a 0% discount or a 0 subtotal", () => {
      expect(percentDiscount(2598, 0)).toBe(0);
      expect(percentDiscount(0, 10)).toBe(0);
    });

    it("produces integer cents (no float residue)", () => {
      const d = percentDiscount(1299, 10);
      expect(Number.isInteger(d)).toBe(true);
    });
  });

  describe("formatCents", () => {
    it("formats integer cents as a decimal string", () => {
      expect(formatCents(1299)).toBe("12.99");
      expect(formatCents(5)).toBe("0.05");
      expect(formatCents(100)).toBe("1.00");
      expect(formatCents(-250)).toBe("-2.50");
    });
  });

  describe("newId", () => {
    it("prefixes a crypto.randomUUID and is unique", () => {
      const a = newId("cart");
      const b = newId("cart");
      expect(a).not.toBe(b);
      expect(a).toMatch(
        /^cart_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });
});
