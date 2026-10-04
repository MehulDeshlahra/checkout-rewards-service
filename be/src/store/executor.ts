/**
 * SerialExecutor: the concurrency-control layer (design Section 4.1).
 *
 * All mutating operations are submitted here and run one at a time against the
 * in-memory store. The executor holds an internal promise chain ("tail"): each
 * submitted task awaits the previous task's completion before running, giving
 * the store single-threaded-transaction-log semantics. Tasks run FIFO to
 * completion through all their awaits, so there is no mid-task interleaving.
 */

/**
 * Optional hook used ONLY by the SerialExecutor unit test to assert FIFO
 * ordering and throw-safety. It is never called on the production hot path
 * (design Section 4.2): parking a task mid-critical-section would only stall
 * the whole executor, never create real interleaving.
 */
export type YieldHook = (label: string) => Promise<void> | void;

export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Submit a task. It runs after every previously-submitted task completes.
   * Returns the task's own promise (so the caller sees its result/rejection),
   * while the stored tail swallows rejection so one failing task does not break
   * the chain for subsequent tasks.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task());
    // Keep the chain alive regardless of task success/failure.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
