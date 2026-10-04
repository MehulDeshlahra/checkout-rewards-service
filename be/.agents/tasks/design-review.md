# Design Review — Reliable Checkout and Rewards Service

**Reviewer:** Design-review subagent (fresh read, no prior authoring context)
**Design under review:** `be/.agents/tasks/design.md`
**Authoritative requirements:** `be/README.md`
**Repository state:** The `be/` directory currently contains only `README.md` plus the design/task docs under `.agents/tasks/`. **No source code exists yet** — this is a pre-implementation design review. "Verify the existing helper" therefore reduces to verifying the design's internal consistency and its claims against the known runtime semantics of the locked stack (Node, promises, `Math.round`, Fastify `inject`, `zod`). All claims about files under `src/` are claims about code *to be written*, not code that can be read.

---

## Summary

This is a strong, unusually self-aware design. It has already absorbed three prior review rounds (Section 18) and most of the hard correctness traps — oversell, idempotent replay, coupon reserve/release, milestone idempotency, integer-cents money, non-negative discount, read-only reconciling report — are specified concretely and are testable as written. The core concurrency mechanism (a single serialized promise-chain executor) is sound and the FIFO-determinism argument for the required competing-operations test holds.

The findings below are mostly MEDIUM gaps where a reachable runtime behavior is still unspecified enough that two implementers could diverge, plus a couple of NITs. There is one HIGH: the report's consistency guarantee is overstated for `purchasedQuantityByProduct` / revenue aggregation and, more importantly, the report is NOT routed through the executor while mutations are — the "no `await` between reads" claim does not by itself guarantee a snapshot consistent with the serialized write log, and the design asserts reconciliation identities that can transiently fail.

Verdict is mechanical: findings with severity HIGH or MEDIUM are present, so the verdict is **CHANGES_REQUESTED**.

---

## Findings

### 1. HIGH — Report consistency vs. the executor is asserted but not actually guaranteed

**Where:** Section 4.1 ("Read-only operations ... do not go through the executor ... each read observes a consistent snapshot"), Section 12 (reconciliation invariants I5, "observes a consistent view"), Section 14 (report test asserts `net = gross - discounts`, `generated = available + reserved + redeemed`, etc.).

**Problem:** The design's consistency argument is "a read handler performs no `await` between its reads of the store, so no mutation can interleave mid-read." That is true *only if the report builder genuinely performs zero `await` from its first store read to its last*. The design never states this as a hard constraint on the reporting code, and the natural Fastify handler shape is `async` and may `await` (e.g. `reply.send`, logging, schema serialization). The moment any `await` separates the read of `orders` from the read of `coupons`, a queued executor task (a committing checkout) can run in that gap and the report can observe orders updated but coupons not yet, breaking the asserted identity `coupons.redeemed === count(orders with couponCode != null)` and `generated === available + reserved + redeemed`. The report is the one place the spec explicitly demands reconciliation ("the report should reconcile with the orders and coupons"), so an unspecified interleaving window here is a correctness risk, not a nit.

A second, smaller part of the same problem: the design says a `reserved` coupon "exists only transiently inside a single executor task" and so a report "never observes a coupon mid-transition." That is only guaranteed if the report snapshots all state in one synchronous, `await`-free pass. The design relies on this property but does not make it a stated, testable rule for the reporting module.

**Concrete fix:** Make the snapshot rule an explicit, enforced contract rather than an emergent property:
- State in Section 12 that `reporting.buildReport()` MUST read every map it needs (orders, coupons, config, counter) into local variables in a single synchronous function body with **no `await` anywhere in that function**, and only then compute aggregates. Add this as a named rule, e.g. "R-REPORT-SYNC: the report builder is fully synchronous; the route handler may be `async` but must call the synchronous builder and perform no `await` between the builder's internal reads."
- Alternatively (more robust, and the honest production answer): route the report read through the executor as a read task so it is ordered against writes. The design rejects this for non-blocking reasons; if it keeps reads off the executor, the synchronous-builder rule above is mandatory and should be unit-asserted (e.g. a test that interleaves a report call between two serialized checkouts and asserts the identities still hold).
- Either way, Section 14's report test should be strengthened to place/commit an order *concurrently with* a report call (fire report via the same `Promise.all` pattern used for the oversell test) and assert the identities, so the snapshot property is actually exercised rather than assumed.

---

### 2. MEDIUM — `successfulOrderCount` / `milestoneSequence` source and ordering under the executor is underspecified

**Where:** Section 3 (Order.`milestoneSequence`), Section 7.2 step 7b ("increment global `successfulOrderCount` -> this order's `milestoneSequence`"), Section 8.1 (`eligibleMilestone = floor(successfulOrderCount / n) * n`), Section 12 (`ordersPlaced = count of Orders`).

**Problem:** There are two independent "order count" notions and the design does not state they are the same source of truth: (a) a mutable `successfulOrderCount` incremented at commit, and (b) `count of Orders` used by the report for `ordersPlaced` and `milestonesReached`. If both exist, they can drift (e.g. a bug increments the counter but order insert fails, or vice versa). The design asserts `ordersPlaced = count of Orders` for the report but uses `successfulOrderCount` for milestones — nothing states these are guaranteed equal, yet invariant I4 and the reconciliation identity `generated <= milestonesReached` depend on it.

**Concrete fix:** Pick one source of truth and state it. Simplest: define `ordersPlaced` everywhere as `orders.size` (the count of committed Order objects), and derive `milestoneSequence` at commit as `orders.size` *after* insertion (or `successfulOrderCount` defined as exactly that count). Add a sentence to Section 7.2 step 7b: "`milestoneSequence = orders.size` immediately after this order is inserted; there is no separate counter — `successfulOrderCount` is an alias for `orders.size`." This removes any possibility of counter/collection drift and makes I4 and `generated <= milestonesReached` provable from a single number.

---

### 3. MEDIUM — Idempotency `requestFingerprint` does not include quantities, so a mismatch is silently replayed

**Where:** Section 3 (`requestFingerprint = `${cartId}|${couponCode ?? ""}``), Section 7.1 (fingerprint match → replay; differs → `IDEMPOTENCY_KEY_REUSED`).

**Problem:** The fingerprint is `cartId | couponCode` only. Checkout targets a cart by id, and cart contents are mutable up to checkout. Consider: client sends checkout for `cartId=c1`, `Idempotency-Key=k`, it commits. The cart is now `checked_out` and immutable, so for the *same* cart the body cannot change meaningfully — fine. But the fingerprint is explicitly the key branch's guard against "same key, different params." Because quantities and line composition are not part of the fingerprint (they live on the mutable cart, captured only in the committed order), the fingerprint cannot detect a key reused across a materially different intended purchase that happens to share `cartId` and `couponCode`. In the single-cart-per-key normal flow this is harmless, but the design presents the fingerprint as the integrity check for key reuse, and it only covers two of the inputs that determine the order. This is an ambiguity about what "same request" means that the design states it has resolved but hasn't fully.

**Concrete fix:** Either (a) explicitly scope and document the fingerprint as "cart identity + coupon only, which is sufficient because a committed cart is immutable and a key is expected to map 1:1 to a cart" — i.e. state the assumption that makes the two-field fingerprint sufficient — or (b) include a snapshot of the request-determining inputs at first commit (cart line signature: sorted `productId:quantity` pairs) in the fingerprint. Given the timebox, (a) is acceptable but must be written down as an explicit assumption in Section 7.1 and Section 17, not left implicit.

---

### 4. MEDIUM — `attemptId` / `reservedBy` origin is unspecified, yet reservation ownership depends on it

**Where:** Section 3 (Coupon.`reservedBy: string | null` = "idempotency key / checkout attempt id holding the reservation"), Section 7.2 step 4c (`reservedBy = attemptId`).

**Problem:** `attemptId` is used to tag a coupon reservation but is never defined: is it the `Idempotency-Key` (which is optional — may be absent), a per-request generated id, or the cart id? The design says "idempotency key / checkout attempt id" with a slash, i.e. two different things. Because the whole checkout runs in one serialized task and release/redeem happen in that same task, `reservedBy` is never actually read to make a decision (the state machine `available→reserved→redeemed` is enforced by `status`, not by matching `reservedBy`). So `reservedBy` is currently a write-only field — set but never compared — which is the same "dead field" smell the design already removed for `Product.version` (Finding 8, round 1).

**Concrete fix:** Decide one of:
- If `reservedBy` is genuinely never read within a single serialized task (it isn't, by the design's own atomicity argument), **remove it** for the in-memory design and note that the multi-instance DB version would use it (or a transaction id) to scope conditional updates. This mirrors the `version`-field removal.
- If it is kept, define `attemptId` precisely (e.g. "a per-checkout-request UUID generated at handler entry, independent of the optional `Idempotency-Key`") and state where it is read. Do not leave it as "key / attempt id."

---

### 5. MEDIUM — Concurrent `POST /carts` / cart creation and id generation are unspecified; test fixtures assume ids exist

**Where:** Section 10 (`POST /carts` → `201 {id,...}`), Section 4.2 and Section 14 test snippets use literal cart ids (`cA`, `cB`, `/carts/c_123/checkout`).

**Problem:** The design specifies that *mutations* go through the executor and that cart creation is a mutation ("All mutating cart ops run through the executor"), but it never specifies how cart ids (and order ids, coupon-free ids) are generated — counter, UUID, `crypto.randomUUID()`? Id generation collides directly with determinism goals: if ids are random, the test fixtures that reference fixed `cA`/`cB`/`c_123` must first create carts and capture returned ids, which the snippets elide. This is a small feasibility/consistency gap: the Section 14 oversell snippet reads as if `cA`/`cB` are pre-existing, but there is no seeding of carts (only products are seeded).

**Concrete fix:** Add one line to Section 3/Section 6.1 specifying id generation (recommend `crypto.randomUUID()` for carts/orders; it needs no determinism because tests capture the returned id). Then adjust the Section 14 snippets to show the real shape: `const { id: cA } = (await app.inject POST /carts)...; add item; ... then fire the two checkouts via Promise.all`. This keeps the determinism claim honest (determinism comes from executor FIFO on the *checkouts*, not from id values).

---

### 6. NIT — "FIFO guarantees exactly one 201 / one 409" depends on both injects being enqueued before either runs; state the micro-task assumption

**Where:** Section 4.2 (`const p1 = app.inject(...); const p2 = app.inject(...); await Promise.all([p1,p2])` → "exactly one commits ... the other ... fails").

**Problem:** The determinism argument is correct *provided* both checkout tasks are submitted to the executor before the first one's critical section mutates inventory. With `app.inject`, each call runs synchronously up to its first `await`; both handlers enqueue their executor task on the microtask-ordered tail. This is true for the real Fastify/inject flow, but the design states the conclusion ("deterministically 1") without stating the premise (both tasks enqueue before either body runs, which holds because `run()` chains on `this.tail` synchronously at submission). If an implementer added an `await` *before* `executor.run(...)` in the checkout handler (e.g. awaiting body parsing or a pre-check), submission order could invert relative to inject order and the "exactly one 201" assertion could still hold but the *which* cart wins could vary — only a problem if a test asserts a specific winner.

**Concrete fix:** Add a sentence to Section 4.2: "The checkout handler must call `executor.run(...)` with no preceding `await` in the handler body so that task submission order equals request arrival order; tests assert the *counts* (one 201, one 409) and final inventory, not which specific cart wins." This matches what Section 14 already asserts (counts + inventory), so just make the no-pre-await rule explicit.

---

### 7. NIT — `GET /admin/coupons` response omits fields the tests rely on

**Where:** Section 10 (`GET /admin/coupons` → `200 [{code,percentOff,milestone,status}]`), Section 14 (coupon-survival test asserts "the coupon is back to `available`"; concurrency test asserts "coupon ends `redeemed`").

**Problem:** The admin coupons list returns `status` (good, enough for the `available`/`redeemed` assertions). Minor: the list omits `reservedBy` / `redeemedByOrderId`, which is fine for the stated tests, but Section 12's report counts `reserved` and the design wants reserved to be observable "for defensiveness." No correctness impact; purely a completeness note so the implementer doesn't later discover a test needs a field the documented shape omits.

**Concrete fix:** Either confirm `status` alone is sufficient for all Section 14 coupon assertions (it is, as written) and leave the shape, or add `reservedBy`/`redeemedByOrderId` to the documented shape if any test will assert reservation ownership. No change required for correctness; flagged for consistency.

---

## Verified Assumptions

These claims in the design were checked against known runtime semantics of the locked stack (no project source exists to read) and hold:

1. **`SerialExecutor` promise-chain correctness (Section 4.1).** `result = this.tail.then(() => task())` defers `task()` until the prior tail settles; `this.tail = result.then(() => {}, () => {})` swallows rejection so one failing task does not break the chain; the original `result` is returned so the caller still sees the task's resolution/rejection. This is a correct, standard serial-queue pattern and delivers the claimed "run-to-completion, no interleaving for mutations" property on single-threaded JS.
2. **Discount rounding example (Section 8.3 / Section 9).** `Math.round((1299 * 10) / 100) = Math.round(129.9) = 130` cents. Correct. `Math.round` is half-up for positive values, matching the stated rule. Clamp to `[0, subtotal]` guarantees `total = subtotal - discount >= 0`, satisfying "discount never makes the total negative."
3. **Integer-cents money path (Section 9).** No client-supplied monetary inputs; prices seeded as integer cents; `unitPriceCents * quantity` and sums stay integer; the single division is immediately rounded. No float enters the money path. Satisfies "calculate money without floating-point rounding errors."
4. **Milestone math (Section 8.1).** `floor(count/n)*n` with `n >= 1` (enforced by `loadConfig`) cannot divide by zero and yields the largest reached milestone; `generatedMilestones` set membership gives at-most-once generation (I4). Internally consistent.
5. **Reserve-then-commit reachability (Section 7.2 steps 4–7, Section 18.1 Finding 4).** Reserving the coupon *before* inventory validation makes the release/compensation path reachable via the easily-triggered `INSUFFICIENT_INVENTORY`, so the "coupon survives a failed checkout" invariant is genuinely testable. The reasoning is sound.
6. **Idempotency single-status model (Section 3, Section 7.1, Section 18.1 Finding 2).** Writing a record only on commit, inside the serialized task, means no second request can observe a partial record in a single process; a failed attempt leaves no record and a retry proceeds fresh. The removal of `in_progress`/`IDEMPOTENCY_CONFLICT` is consistent for the single-instance model, and the DB `UNIQUE(key)` seam is correctly identified as where the multi-instance window reappears.
7. **Key-check-before-cart-status ordering (Section 7.1/7.2, Section 18.2 Finding 1).** With the key lookup ahead of the cart-status short-circuit, the `IDEMPOTENCY_KEY_REUSED` (422) branch is reachable (same key, different body, original cart already `checked_out`). The ordering argument is correct.
8. **Fastify `app.inject()` + fresh `buildApp({store,config,yieldHook})` per test (Sections 2, 14).** Supported by Fastify; gives isolated in-process tests with no sockets. Feasible as described.
9. **Config fail-fast via `zod` in `loadConfig` (Section 8).** `n` integer `>= 1`, `x` integer `[0,100]`, throwing before `listen`, is feasible and closes the divide-by-zero and negative/over-100 discount risks at the boundary.

## Unverified / Wrong Assumptions

1. **"Read handlers observe a consistent snapshot" (Section 4.1, Section 12) — UNVERIFIED / conditionally wrong.** True only if the report builder is strictly synchronous with no `await` between its reads. The design relies on this but does not state or enforce it, and the natural `async` handler shape can break it. See Finding 1. This is the one assumption that is both load-bearing for the graded reconciliation requirement and not actually guaranteed by the design as written.
2. **"`ordersPlaced = count of Orders`" equals the milestone counter — UNVERIFIED.** The design uses `successfulOrderCount` for milestones and `count of Orders` for the report without stating they are the same source. See Finding 2.
3. **`requestFingerprint` captures "the request" — PARTIALLY WRONG.** It captures only `cartId | couponCode`, not quantities/line composition; the design presents it as the key-reuse integrity guard without stating the immutable-cart assumption that makes two fields sufficient. See Finding 3.
4. **`attemptId` is defined — WRONG (undefined).** Referenced in step 4c and `reservedBy` but never defined; and `reservedBy` is currently never read. See Finding 4.
5. **Test cart ids (`cA`, `cB`, `c_123`) pre-exist / id generation scheme — UNVERIFIED.** Id generation is unspecified and only products are seeded; the test snippets elide cart creation. See Finding 5.
6. **No existing-source claims could be verified** because the `be/` tree contains no implementation yet. Every `src/` module named in Section 2 is prospective. This is expected for a pre-implementation design review and is not itself a finding, but it means none of the "the existing helper handles X" style claims exist here to be falsified — the risk surface is entirely in the specification's internal consistency, covered by the findings above.

---

## Verdict

HIGH findings: 1 (Finding 1).
MEDIUM findings: 4 (Findings 2, 3, 4, 5).
NIT findings: 2 (Findings 6, 7).

HIGH + MEDIUM = 5 > 0 → **CHANGES_REQUESTED**.

The design is close. The required fixes are mostly tightening specifications so two implementers cannot diverge: make the report's snapshot rule explicit and enforced (the one HIGH), unify the order-count source of truth, pin down the fingerprint's scope and `attemptId`, and specify id generation. None of these require rethinking the architecture — the executor-based concurrency model, reserve-then-commit coupon flow, idempotency model, and money rules are all sound as verified above.
