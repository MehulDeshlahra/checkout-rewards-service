import { describe, it, expect } from "vitest";
import { loadConfig, seedProducts } from "../src/config.js";

describe("loadConfig", () => {
  it("accepts the defaults when env is empty (n=5, x=10)", () => {
    expect(loadConfig({})).toEqual({ n: 5, x: 10 });
  });

  it("accepts valid explicit values", () => {
    expect(loadConfig({ REWARD_N: "3", REWARD_X: "25" })).toEqual({ n: 3, x: 25 });
    // Boundary values are valid.
    expect(loadConfig({ REWARD_N: "1", REWARD_X: "0" })).toEqual({ n: 1, x: 0 });
    expect(loadConfig({ REWARD_X: "100" })).toEqual({ n: 5, x: 100 });
  });

  it("throws for n = 0 (would divide-by-zero in milestone math)", () => {
    expect(() => loadConfig({ REWARD_N: "0" })).toThrow(/REWARD_N/);
  });

  it("throws for negative n", () => {
    expect(() => loadConfig({ REWARD_N: "-1" })).toThrow(/REWARD_N/);
  });

  it("throws for x = 101 (out of [0,100])", () => {
    expect(() => loadConfig({ REWARD_X: "101" })).toThrow(/REWARD_X/);
  });

  it("throws for negative x", () => {
    expect(() => loadConfig({ REWARD_X: "-5" })).toThrow(/REWARD_X/);
  });

  it("throws for non-integer n", () => {
    expect(() => loadConfig({ REWARD_N: "2.5" })).toThrow(/REWARD_N/);
  });

  it("throws for non-integer x", () => {
    expect(() => loadConfig({ REWARD_X: "10.5" })).toThrow(/REWARD_X/);
  });

  it("throws for non-numeric input", () => {
    expect(() => loadConfig({ REWARD_N: "abc" })).toThrow(/REWARD_N/);
  });
});

describe("seedProducts", () => {
  it("provides >= 5 products including p_limited with inventory 3", () => {
    const products = seedProducts();
    expect(products.length).toBeGreaterThanOrEqual(5);
    const limited = products.find((p) => p.id === "p_limited");
    expect(limited).toBeDefined();
    expect(limited?.inventory).toBe(3);
  });

  it("returns a fresh copy each call (no shared mutable state)", () => {
    const a = seedProducts();
    const b = seedProducts();
    expect(a).not.toBe(b);
    a[0]!.inventory = 999;
    expect(b[0]!.inventory).not.toBe(999);
  });
});
