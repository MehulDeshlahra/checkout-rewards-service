import { describe, it, expect } from "vitest";
import { SerialExecutor, type YieldHook } from "../src/store/executor.js";

/**
 * Build a controllable yield hook: each call to the hook returns a promise that
 * only resolves when the test releases the matching label. This lets the test
 * submit two tasks before either resolves and assert strict FIFO ordering
 * (design Section 4.2 — the hook lives in the executor unit test only).
 *
 * `waitParked(label)` resolves once a task has reached the hook at `label`, so
 * the test can synchronize on observable progress rather than guessing a fixed
 * number of microtask turns.
 */
function makeGate() {
  const resolvers = new Map<string, () => void>();
  const parkedWaiters = new Map<string, () => void>();
  const parked = new Set<string>();

  const hook: YieldHook = (label: string) =>
    new Promise<void>((resolve) => {
      resolvers.set(label, resolve);
      parked.add(label);
      const notify = parkedWaiters.get(label);
      if (notify) {
        parkedWaiters.delete(label);
        notify();
      }
    });

  const release = (label: string) => {
    const r = resolvers.get(label);
    if (!r) throw new Error(`no task is parked at label '${label}'`);
    resolvers.delete(label);
    parked.delete(label);
    r();
  };

  const waitParked = (label: string) =>
    new Promise<void>((resolve) => {
      if (parked.has(label)) {
        resolve();
        return;
      }
      parkedWaiters.set(label, resolve);
    });

  return { hook, release, waitParked };
}

describe("SerialExecutor", () => {
  it("runs tasks strictly FIFO even when both are submitted before either resolves", async () => {
    const executor = new SerialExecutor();
    const order: string[] = [];
    const { hook, release, waitParked } = makeGate();

    // Submit both tasks WITHOUT awaiting the first (the whole point).
    const p1 = executor.run(async () => {
      order.push("start-1");
      await hook("task-1");
      order.push("end-1");
      return 1;
    });
    const p2 = executor.run(async () => {
      order.push("start-2");
      await hook("task-2");
      order.push("end-2");
      return 2;
    });

    // Task 1 runs first and parks at its hook; task 2 has not started.
    await waitParked("task-1");
    expect(order).toEqual(["start-1"]);

    // Release task 1; task 2 must not start until task 1 has fully completed,
    // at which point task 2 parks at its own hook.
    release("task-1");
    await waitParked("task-2");
    expect(order).toEqual(["start-1", "end-1", "start-2"]);

    release("task-2");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("does not break the chain when a task throws: the next task still runs", async () => {
    const executor = new SerialExecutor();
    const order: string[] = [];

    const failing = executor.run(async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const next = executor.run(async () => {
      order.push("next");
      return "ok";
    });

    // The failing task's own promise rejects to the caller...
    await expect(failing).rejects.toThrow("boom");
    // ...but the chain survives and the next task runs and resolves.
    await expect(next).resolves.toBe("ok");
    expect(order).toEqual(["failing", "next"]);
  });
});
