# DECISIONS

Design decisions, invariants, and trade-offs for the Reliable Checkout and
Rewards Service. This document is the companion to the code; where it refers to
"the executor" it means the single `SerialExecutor` in `src/store/executor.ts`.

---

## System invariants

These are the correctness properties the system guarantees. Each is enforced in
one place, inside the serial executor, so there is a single critical section to
reason about.

| id | invariant | where enforced |
|----|-----------|----------------|
| **I1** | **No oversell.** The system never sells more units than are in stock. | `src/domain/checkout.ts`: inventory is read, validated, and decremented inside one executor task. A competing checkout runs only after the first has committed its decrement, so both can never pass the "enough inventory" check against the same stock. Proven by `test/concurrency.test.ts` (oversell race). |
| **I2** | **At-most-once checkout per cart.** A cart produces at most one order. | `src/domain/checkout.ts`: the `open -> checked_out` status transition happens inside the executor; a second checkout sees `checked_out` and either replays (idempotent) or returns `409 CART_ALREADY_CHECKED_OUT`. |
| **I3** | **Single coupon redemption.** A coupon is redeemed at most once and is never redeemed by two concurrent checkouts. | `src/domain/coupons.ts` (`reserveCoupon` / `redeemCoupon` / `releaseCoupon`) driven from `checkout.ts`: the `available -> reserved -> redeemed` transition runs inside the executor. The second of two racing checkouts sees `status != available` and gets `409 COUPON_NOT_REDEEMABLE`. Proven by `test/concurrency.test.ts` (coupon race). |
| **I4** | **Milestone rewarded at most once.** Each order milestone yields at most one coupon. | `src/domain/coupons.ts` (`generateCoupon`): the "has this milestone been rewarded?" check and the `generatedMilestones.add(...)` happen in one executor task. `generatedMilestones` is the single source of truth. |
| **I5** | **Report reconciliation.** The report always reconciles with stored orders and coupons, and repeated reads never mutate state. | `src/domain/reporting.ts` (`buildReport`): a fully synchronous builder (no `await`) that observes a consistent snapshot and recomputes every figure from `orders` + `coupons`. Proven by `test/report.test.ts` and `test/report-concurrency.test.ts`. |

Supporting identities the report asserts (all follow from I5):

- `netRevenueCents === grossRevenueCents - totalDiscountsCents`
- `coupons.generated === available + reserved + redeemed`
- `coupons.redeemed === count(orders with couponCode != null)`
- `coupons.generated <= milestonesReached` (strict whenever a milestone was forfeited)

---

## Ambiguities found and the semantics chosen

The brief left several points open. The choices below are the ones the system
actually implements.

- **Price/availability change after add, before checkout.** Cart lines store
  only `{ productId, quantity }`. The **price is captured at checkout** from the
  current product price, and **inventory is validated only at checkout**.
  Viewing a cart always reflects current prices (indicative, never a quote). The
  order snapshot is the authoritative record of what was charged. If stock
  dropped below the requested quantity, checkout fails with
  `INSUFFICIENT_INVENTORY` and the cart stays open to adjust.

- **Idempotency fingerprint.** The `Idempotency-Key` record stores a
  `requestFingerprint = `${cartId}|${couponCode ?? ''}`` compared by string
  equality. **Assumption (F3): a committed cart is immutable, and an
  `Idempotency-Key` maps 1:1 to a single logical checkout of a single cart.**
  Because a cart's lines can no longer change once it is `checked_out`, the
  `(cartId, couponCode)` pair uniquely identifies the request that produced the
  stored order, so a plain delimiter-joined string is a sufficient and
  unambiguous fingerprint — no hashing is needed. A client that reuses a key but
  changes the cart or coupon is caught as `IDEMPOTENCY_KEY_REUSED` rather than
  silently mis-replayed. If a key were ever shared across two different carts,
  this assumption would break; the 1:1 mapping is the client's contract.

- **Coupon lifecycle semantics.** Reserve-then-commit: a coupon moves to
  `reserved` at validation and only `redeemed` on commit; any pre-commit failure
  releases it. So a coupon is never consumed by a failed checkout and never
  stuck in `reserved`.

- **Milestone forfeiture / latest-milestone-only.** `POST
  /admin/coupons/generate` rewards only the **largest reached-but-unrewarded**
  milestone (`floor(ordersPlaced / n) * n`). It does not catch up on skipped
  milestones. If the admin does not call generate before a later milestone is
  reached, the earlier milestone is **forfeited**. This keeps
  `generatedMilestones` a single, simple source of truth for I4; the gap is
  visible because the report surfaces `milestonesReached`.

- **Coupon code format and matching.** Codes match `^SAVE-[A-Z0-9]{6}$`.
  Lookup and the header-less replay comparison are exact, case-sensitive
  equality with no trimming/case folding. The checkout schema accepts only
  `^[A-Z0-9-]{1,64}$`, so generated codes are a strict subset of accepted input
  and round-trip end to end.

- **200 vs 201 on checkout.** A fresh checkout returns `201 Created`; an
  idempotent replay returns `200 OK` + `Idempotent-Replay: true`. Clients
  distinguish "I just created this" from "this already existed."

---

## Material design decisions

### Decision: Single serial executor for all mutations

**Context:** Checkout touches several resources at once (multiple products'
inventory, a coupon, the order count, the idempotency record). The hard part is
preventing interleaving where one request reads stale state between another's
read and write (`read inventory -> await -> write inventory`).

**Options considered:**
1. Per-resource locks (one per product/cart/coupon) for maximum concurrency.
2. A single global serialized command executor.
3. Rely on a database engine's transactions.

**Choice:** A single `SerialExecutor` (a promise-chain tail) through which every
mutation runs one at a time. Reads run off the executor.

**Why:** Per-resource locks reintroduce multi-lock ordering and deadlock
concerns, since a single checkout spans several resources. A DB was explicitly
allowed to be replaced by an in-memory store, and the brief asked us to make the
concurrency reasoning explicit and testable. A single serialization point is the
simplest construct that is obviously correct for the timebox; correctness is
graded over throughput.

**Consequences:** Easier — one critical section to reason about; deterministic
tests via FIFO ordering. Harder/deferred — no parallelism across unrelated carts
(acceptable for a single in-memory instance); the parallelism is recovered at
the DB layer in the multi-instance evolution below.

### Decision: In-memory store, no database

**Context:** The brief allows a real DB, embedded DB, or in-memory store, as
long as invariants are preserved under overlap.

**Options considered:** Postgres/SQLite with transactions; an in-memory store
with explicit application-level serialization.

**Choice:** In-memory `Map`s guarded by the serial executor.

**Why:** It forces the concurrency and idempotency reasoning into application
code where it is directly testable with `app.inject()` + `Promise.all`, instead
of being delegated to an engine. No external dependency to provision for
evaluation.

**Consequences:** Easier — zero-setup evaluation, fully deterministic tests.
Harder/deferred — no persistence across restarts, single process only; the
production mapping is documented below.

### Decision: Capture price at checkout, validate inventory only at checkout

**Context:** The brief requires us to decide what happens when price or
availability changes after an item is added but before checkout.

**Options considered:**
1. Capture price at add time (price lock), with a quote-expiry policy.
2. Reject checkout if the price changed since add.
3. Always charge the current listed price; validate stock at checkout.

**Choice:** Option 3. Cart lines carry only `{ productId, quantity }`.

**Why:** A price lock lets the displayed cart diverge from reality and demands a
quote-expiry policy the brief does not ask for. Rejecting on drift surprises
customers. Charging the current price never surprises a customer with a higher
historical price and matches how storefronts treat an un-submitted cart.

**Consequences:** Easier — the order snapshot is the single authoritative record
of what was charged; no versioning. Deferred — no "price changed since view"
warning (out of scope).

### Decision: Idempotency key is authoritative and checked before cart status

**Context:** A client may retry a checkout it never got a response for. We must
not create a second order, and the `IDEMPOTENCY_KEY_REUSED` branch must be
reachable.

**Options considered:**
1. Dedupe on cart status only (reject any second checkout of a spent cart).
2. Check the `Idempotency-Key` record first, fall back to cart-status dedupe.

**Choice:** Option 2. When a key is present, look it up **first**; a matching
fingerprint replays (200), a differing fingerprint is `IDEMPOTENCY_KEY_REUSED`
(422), no record falls through to the cart-status floor. A record is written
**only on commit** (there is no `in_progress` state).

**Why:** A committed checkout writes the `checked_out` status and the key record
together. If cart status were checked first, it would short-circuit every
same-cart retry before the key was consulted, making the whole key branch dead
code. Checking the key first keeps `IDEMPOTENCY_KEY_REUSED` reachable (same key,
different body) while the header-less comparison remains the floor for clients
that omit the key.

**Consequences:** Easier — robust retries for key-sending clients; cart-id
dedupe still protects header-less clients. Honest limitation — the key only
protects once an attempt has committed; two same-key requests that both race and
both fail write no record and gain nothing (each is a fresh attempt). A failed
checkout created no order and charged no inventory, so there is nothing to
dedupe. This is the single-process analogue of the DB `UNIQUE(key)` seam below.

### Decision: Reserve the coupon before validating inventory

**Context:** "A coupon must not be lost or consumed by a checkout that
ultimately fails." The release/compensation path must be reachable and testable.

**Options considered:**
1. Validate inventory first, then reserve the coupon (reserve last).
2. Reserve the coupon first, then validate inventory.

**Choice:** Option 2. Reserve at step 4, validate/capture prices at step 5,
decrement + redeem only at commit (step 7).

**Why:** With reserve-last, there is no throwing step between reservation and
commit, so the release path is dead code. Reserving first means the most common
failure (`INSUFFICIENT_INVENTORY`) happens with a coupon already reserved,
exercising the release path on a real, easily-triggered path.

**Consequences:** Easier — the coupon-survival invariant is directly testable
(`test/concurrency.test.ts`: over-request `p_limited` with a coupon, assert 409
and the coupon back to `available`). No partial inventory side effect exists
because step 5 only reads/validates — the decrement is a single commit step.

### Decision: No payment abstraction

**Context:** No real payment is required; we may add a fake if it supports the
design.

**Options considered:** A trivial `payment.authorize()` that always succeeds;
treat successful validation + commit as payment success.

**Choice:** No fake. Successful validation + commit is treated as payment
success.

**Why:** A fake that can never fail adds surface without exercising any new
invariant within the timebox. The coupon-release path is already reachable via
`INSUFFICIENT_INVENTORY`, so coupon survival does not depend on a payment seam.

**Consequences:** The natural extension point is documented: insert `await
payment.charge()` after the discount is computed and before the first write; on
failure run the same release/compensation path as any other pre-commit failure.

### Decision: Reward the latest milestone only (no catch-up)

**Context:** Coupons are generated on demand by an admin; what happens if a
milestone is skipped?

**Options considered:**
1. Reward the earliest unrewarded milestone (catch-up; no coupon ever stranded).
2. Reward the latest reached milestone only (forfeiture of skipped ones).

**Choice:** Option 2.

**Why:** It keeps `generatedMilestones` a single, simple source of truth for I4
and the admin action one-coupon-per-call. The forfeiture is explicit and
reconcilable: the report exposes `milestonesReached`, so any gap between reached
and generated is visible.

**Consequences:** Simpler state, a strict `coupons.generated <= milestonesReached`
invariant. Catch-up generation is a noted backlog item, not implemented.

---

## Transaction, concurrency, and idempotency strategy

**The `SerialExecutor` is the whole strategy.** It holds a promise-chain tail;
each submitted task awaits the previous one, so mutations run one at a time to
completion. Within a task we therefore have a true critical section even though
`async`/`await` yields at every `await`. All mutations (cart add/update/remove,
checkout, admin coupon generate) go through it; reads (products, cart view,
order, report) do not, and because a read handler performs no `await` between its
reads of the store, each read sees a consistent snapshot.

**Determinism in tests comes from FIFO ordering, not timing.** Competing
requests are submitted together — `const p1 = app.inject(...); const p2 =
app.inject(...); await Promise.all([p1, p2])` — with no `setTimeout`/sleeps. The
executor serializes them in submission order, so the outcome is fixed and
repeatable: exactly one 201 and one 409. Tests assert counts and final state, not
which specific request wins. An optional `yieldHook` exists only for the
`SerialExecutor` unit test (ordering + throw-safety) and is never wired into the
checkout path, where a parked task would merely stall the queue.

**Idempotency.** `Idempotency-Key` is the robust path: the key is looked up
first inside the executor task, a record is written only on commit (status is
always `completed`, no `in_progress`), a matching fingerprint replays as 200, a
differing fingerprint is `IDEMPOTENCY_KEY_REUSED`. Header-less clients are
protected by the cart-status floor: a retry of a checked-out cart with a matching
coupon replays, a differing coupon is `409 CART_ALREADY_CHECKED_OUT`. Because
dedupe lookup and commit happen inside one serialized task, a second request can
never observe a partially written record.

---

## Money and rounding rules

- All monetary values are **integer cents** (`number`), never floats. No decimal
  library is needed.
- No client-supplied money ever enters the system — prices come from seed data
  (already cents) and quantities are integers.
- Line subtotal = `unitPriceCents * quantity` (integer × integer).
- Order subtotal = sum of line subtotals.
- Discount = `clamp(Math.round(subtotalCents * percentOff / 100), 0, subtotalCents)`.
  The division is the **single** non-integer step and is immediately rounded
  **half-up** via `Math.round`. Rounding is applied to the whole-order subtotal
  (not per line) to avoid per-line rounding drift.
- Total = `subtotalCents - discountCents`, guaranteed `>= 0` by the clamp — a
  discount can never make an order total negative.
- Deterministic: identical inputs always produce identical output.
- Example: subtotal 1299, x = 10 -> `round(12990 / 100) = round(129.9) = 130`
  cents off.

Implemented in `src/money.ts` (pure, unit-tested in `test/money.test.ts`).

---

## Error model

A single `AppError { code, httpStatus, message, details? }` is thrown by all
domain services (`src/errors.ts`). A Fastify `setErrorHandler` maps it to the
common body `{ error: { code, message, details? } }` and the mapped HTTP status.
`zod` validation failures become `VALIDATION_ERROR` (400) with field details;
unexpected errors become `500 INTERNAL_ERROR` with a generic message (no stack
leaked) and are logged at `error` level.

A `ERROR_CODES` registry is the single source of truth mapping each stable code
to its HTTP status and log level. Clients branch on `error.code`, not on message
text. The full table is in [API.md](./API.md). Two codes worth calling out are
split deliberately: `PRODUCT_NOT_FOUND` (404, lookups/add) vs
`PRODUCT_UNAVAILABLE` (409, a cart product removed by checkout time), so a client
can tell "you asked for an unknown product" from "a product in your cart is no
longer available."

---

## Implemented vs. intentionally deferred

**Implemented:**

- Products + inventory with seed data (6 products, `p_limited` stock 3).
- Carts: create, add (summing duplicates), update quantity, remove (idempotent),
  view with live prices and totals.
- Checkout: idempotent (key + header-less), coupon reserve/commit/release,
  immutable order snapshot, oversell-safe.
- Coupons: milestone-driven generation (idempotent per milestone), single
  redemption, survival across failed checkout.
- Reconciling, read-only admin report.
- Full error model with stable codes.
- Fail-fast config validation (`REWARD_N`, `REWARD_X`).
- Tests covering money, executor ordering, config, carts, checkout, coupons,
  report, and competing/repeated operations (oversell race, coupon race,
  report-under-concurrency).

**Intentionally deferred (out of scope for the timebox):**

- Authentication / authorization (admin endpoints are documented as
  administrative only).
- Real payment integration (treated as success; seam documented above).
- A public product price/inventory mutation API (tests mutate via store
  setters).
- Catch-up generation of multiple skipped milestones in one call.
- Persistence across restarts; horizontal scaling implementation (design-level
  mapping only — see below).
- Per-line discount allocation; multiple coupons per order; cart-level
  price-lock / quote expiry; "price changed" warnings on cart view.

---

## Multi-instance and production-scale evolution

The single in-memory executor guarantees the invariants only within one process.
With multiple instances behind a shared, transactional database (for example
Postgres), the enforcement layer moves to the DB while the domain logic stays the
same — the invariants were written so each has a direct DB counterpart:

- **I1 (no oversell):** a conditional update
  `UPDATE products SET inventory = inventory - :q WHERE id = :id AND inventory >= :q`
  and a check on affected rows. Oversell-safe without an application lock.
- **I3 (single coupon redemption):** a conditional update
  `UPDATE coupons SET status = 'redeemed' WHERE code = :c AND status = 'available'`,
  again checking affected rows so two concurrent redemptions cannot both win.
- **I4 (milestone once):** the order counter becomes a DB sequence or a
  `SELECT ... FOR UPDATE` on a counter row.
- **I2 / idempotency:** the idempotency record gets a `UNIQUE(key)` constraint so
  a racing retry collides **deterministically** at the DB. This is the seam the
  single-process model lacks: in-process, two same-key requests that both race
  and both fail write no record and gain nothing from the key; with a
  `UNIQUE(key)` constraint, the first inserter wins and the second gets a
  constraint violation it can translate into a replay or conflict, closing the
  "both in flight" window.
- **I5 (report):** becomes aggregate SQL, still read-only.

**Where `reservedBy` / a transaction id reappears (F4).** The current in-memory
`Coupon` has **no** `reservedBy` field: reservation and release happen inside one
synchronous executor task, so there is no cross-task window and nothing to scope
a release to. In a multi-instance DB version that field (or an equivalent
transaction/attempt id) **comes back** to scope conditional updates to the holder
of the reservation. For example, reservation becomes
`UPDATE coupons SET status='reserved', reserved_by=:txnId WHERE code=:c AND status='available'`
and release becomes
`UPDATE coupons SET status='available', reserved_by=NULL WHERE code=:c AND reserved_by=:txnId`,
so one transaction can only release its own reservation and a crashed transaction
can be reaped by matching its id. The field is deliberately omitted today because
it would be carried but never read in a single process; it is documented here as
the exact place it re-enters at scale.

---

## How AI tools were used

AI assistance was used throughout for drafting the design, scaffolding the
TypeScript modules, and generating test skeletons — then every line was reviewed
and validated against the invariants above and by running the suite.

The most material correction came from the **design-review loop**, which caught
an **infeasible concurrency test**. An early draft placed an in-task yield
barrier (`await yieldHook("checkout:after-validate")`) inside the checkout task
and described "pausing checkout 1, running checkout 2 to completion, then
releasing checkout 1." That is impossible under this executor: while task 1 is
parked at an awaited hook, the executor's tail promise has not resolved, so task
2 cannot start — it is queued, not running. A parked task would only stall the
whole queue. The AI-proposed test assumed an interleaving the architecture
specifically prevents.

The correction: the barrier was removed from the checkout path entirely, and the
required competing-operations test was **re-specified around FIFO executor
ordering** — submit two checkouts via `Promise.all` without awaiting the first,
and assert the deterministic outcome (one 201, one 409, final inventory exactly
1). The `yieldHook` was retained only for the `SerialExecutor` unit test, which
asserts submission-order execution and that a throwing task does not break the
chain. This is the version that ships (`test/concurrency.test.ts`), and it is
what separates the test suite from a happy-path-only one.

---

## What I would examine first with another two hours

1. **Property/fuzz test the executor and checkout** — generate randomized
   interleavings of concurrent carts/coupons and assert the I1–I5 identities
   always hold, to find any ordering edge case the hand-written races miss.
2. **The idempotency racing-retry window** — add a test that forces two same-key
   requests to both fail, confirm neither leaves a record, and document (or
   prototype) the DB `UNIQUE(key)` behavior that would change this at scale.
3. **A thin DB-backed store adapter** behind the same domain interfaces to
   validate that the I1/I3/I4 conditional-update mapping actually holds, turning
   the Section-15 design claims into a running proof.

---

## Approximate time spent

Approximately **4–6 hours**, in line with the timebox: design and design-review
loop, core implementation (store, executor, domain services, HTTP layer),
tests (including the competing-operations suite), and documentation.
