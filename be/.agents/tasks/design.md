# Design: Reliable Checkout and Rewards Service

## 1. Overview

This document specifies the technical design for a backend ecommerce checkout and rewards service. The service manages products with limited inventory, shopping carts, idempotent checkout producing immutable orders, a milestone-driven coupon reward system, and a read-only admin report that reconciles with stored state. The design is graded on correctness invariants and on an explicit, test-visible strategy for concurrency, idempotency, and coupon reservation — not on feature breadth.

The data store is in-memory by deliberate choice: it forces the concurrency and idempotency reasoning to be explicit in application code (a serialized command executor) rather than delegated to a database engine, and it makes that reasoning directly testable through an injectable scheduling hook. Section 4 defines this concurrency layer; it is the backbone of the whole design and every mutating operation flows through it.

The architecture is a thin HTTP layer (Fastify routes) over a set of domain services (Products, Carts, Checkout/Orders, Coupons, Reporting), all mutating operations of which run inside a single serialized executor that owns the in-memory store. HTTP handlers validate and translate; services enforce invariants; the executor guarantees that no two mutations interleave.

## 2. Technology Stack (locked)

The following choices are fixed by this design and must not be revisited by the implementer:

- **Language / runtime:** TypeScript (strict mode) on Node.js (LTS, >= 20).
- **HTTP framework:** Fastify.
- **Data store:** In-memory (plain JS `Map`s inside a store module). No external DB, no embedded DB.
- **Test runner:** **Vitest**. Chosen over node's built-in runner because it has first-class TypeScript support (no separate build/loader step), a mature `expect` API, and simple async concurrency testing. `npm test` runs the suite **once, non-watch** (`vitest run`).
- **Validation:** `zod` for request body/param schema validation and type inference. One well-known dependency that removes hand-rolled validation and keeps the error model consistent.
- **HTTP testing:** Fastify's built-in `app.inject()` (no network sockets) for route tests; no additional HTTP client dependency.
- **Money:** integer **minor units (cents)**. No floating point for monetary values. No decimal library needed — all amounts are `number` integers representing cents, and all arithmetic is integer arithmetic. Rationale and rounding rules in Section 9.

Dependencies are pinned to **exact** versions in `package.json` (no `^`/`~`). Minimal set: `fastify`, `zod`, and dev-only `typescript`, `vitest`, `@types/node`, `tsx` (for running the dev server). `tsx` is dev-only and well-known; it avoids a separate build step for local run.

### Project layout

```
be/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    config.ts            # loadConfig(env): validates n, x (fail-fast), seed data
    money.ts             # integer-cents helpers + percentage discount
    errors.ts            # AppError + ERROR_CODES registry
    store/
      store.ts           # in-memory Maps (products, carts, orders, coupons, idempotency, milestones)
      executor.ts        # SerialExecutor (the concurrency-control layer)
    domain/
      types.ts           # Product, Cart, Order, Coupon, Report types
      products.ts        # product + inventory service
      carts.ts           # cart service
      checkout.ts        # checkout + order service (the critical section)
      coupons.ts         # coupon generation + reserve/commit/release
      reporting.ts       # read-only report builder
    http/
      app.ts             # Fastify app factory (buildApp(deps))
      routes/
        carts.ts
        checkout.ts
        orders.ts
        products.ts
        admin.ts
      error-handler.ts   # maps AppError -> HTTP status + body
    server.ts            # entry: buildApp() + listen()
  test/
    *.test.ts
```

The app is built by a `buildApp(deps)` factory so tests can inject a fresh store, a fixed config, and the scheduling hook. `server.ts` only wires defaults and calls `listen`.

## 3. Domain Model

All money fields are integers in **cents**.

**Product**
- `id: string` (stable, e.g. `"p_apple"`)
- `name: string`
- `priceCents: number` (current unit price, integer >= 0)
- `inventory: number` (available units, integer >= 0)

(No `version` field: this design does not block checkout on price/inventory drift — the cart always reflects current product state and checkout re-reads it fresh, so a version counter would be carried but never read. Omitted deliberately for the timebox; see Section 6.2.)

**CartLine**
- `productId: string`
- `quantity: number` (integer >= 1)
- (prices are **not** stored on the line; they are computed on view and captured at checkout — Section 6)

**Cart**
- `id: string`
- `lines: CartLine[]`
- `status: "open" | "checked_out"`
- `orderId: string | null` (set when checked out)
- `createdAt`, `updatedAt` (ISO strings)

**Order** (immutable snapshot once created)
- `id: string`
- `cartId: string`
- `lines: OrderLine[]` where `OrderLine = { productId, name, unitPriceCents, quantity, lineSubtotalCents }`
- `subtotalCents: number` (sum of line subtotals, pre-discount)
- `discountCents: number` (>= 0)
- `totalCents: number` (= subtotal - discount, >= 0)
- `couponCode: string | null`
- `createdAt: string`
- `milestoneSequence: number` (this order's 1-based position in the sequence of successfully placed orders; drives coupon milestones)

**Coupon**
- `code: string`
- `percentOff: number` (= `x`)
- `milestone: number` (the order-count milestone this coupon rewards, e.g. 5, 10, 15)
- `status: "available" | "reserved" | "redeemed"`
- `reservedBy: string | null` (idempotency key / checkout attempt id holding the reservation)
- `redeemedByOrderId: string | null`
- `createdAt`, `updatedAt`

**IdempotencyRecord** (keyed by `Idempotency-Key` header value, scoped to checkout)
- `key: string`
- `cartId: string`
- `requestFingerprint: string` — a plain delimiter-joined string `` `${cartId}|${couponCode ?? ""}` ``, compared by equality. No hashing / crypto dependency: for a single-process in-memory store a string key is sufficient and unambiguous.
- `status: "completed"` — the record is only ever written on completion of a committed checkout (see note below). There is **no** `in_progress` state.
- `orderId: string` (the committed order)
- `responseBody: object` (the order body to replay; identical to the original 201 body)

> The original committed checkout returns **201**; a replay served from this record returns **200** with `Idempotent-Replay: true` (Section 7.1, "200 vs 201 is intentional"). The replay status is therefore not stored on the record — it is always 200 by construction — only the body is stored.

> **No `in_progress` state (deliberate).** Dedupe lookup and commit happen inside one serialized executor task, so a second request can never observe a partially-written record: the first task either committed (record exists, `completed`) or failed (no record written at all) *before* the next task runs. There is therefore no reachable "a request with this key is still being processed" window in a single process, so persisting `in_progress` and defining an `IDEMPOTENCY_CONFLICT` error would be dead code. A failed checkout writes **no** idempotency record, so a legitimate retry with the same key proceeds as a fresh attempt. (The multi-instance seam where such a window *does* exist is handled by a DB `UNIQUE(key)` constraint — Section 15.)

**MilestoneRecord** (tracks which milestones have had a coupon generated)
- Stored as a `Set<number>` of milestones already rewarded (`generatedMilestones`).

## 4. Concurrency Control (the core of the design)

### 4.1 Mechanism: a single serialized command executor

All **mutating** operations (add to cart, update qty, remove, checkout, admin coupon generation) are submitted to one `SerialExecutor` that runs them **one at a time** against the in-memory store. The executor holds an internal promise chain (a "tail"): each submitted task awaits the previous task's completion before running. This gives the store the semantics of a single-threaded transaction log — exactly the property an RDBMS transaction would provide, but made explicit in application code.

```
class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task());
    // keep chain alive regardless of task success/failure:
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
```

Node.js is single-threaded for JS execution, but `async`/`await` yields at every `await`, which is where interleaving bugs appear (read inventory → await → write inventory, with another request reading stale inventory in between). The executor removes that interleaving for mutations by ensuring a task runs to completion (through all its `await`s) before the next starts. Within a single task we therefore have a true critical section.

**Why a single global executor and not per-resource locks:** per-resource locks (one lock per product, per cart, per coupon) are more concurrent but a checkout touches multiple resources at once (several products' inventory + a coupon + the order counter + idempotency record), which reintroduces multi-lock ordering and deadlock concerns. Given the timebox and that correctness is graded over throughput, a single serialization point is the simplest construct that is obviously correct. The trade-off (reduced parallelism) is documented and acceptable for an in-memory single-instance service; Section 12 explains how this evolves at production scale.

Read-only operations (view cart, get order, get products, admin report) do **not** go through the executor. Because JS is single-threaded and a read handler performs no `await` between its reads of the store, each read observes a consistent snapshot (no mutation can interleave mid-read). This keeps the report truly read-only and non-blocking.

### 4.2 Making concurrency deterministically testable

The executor itself is what makes concurrency tests deterministic: because tasks run FIFO to completion, submitting two mutating requests *without awaiting the first* produces a fixed, repeatable outcome. There is no need for `setTimeout`-based timing in the integration tests. The required competing-operations test (Section 14) exploits this directly:

```ts
const p1 = app.inject({ method: "POST", url: "/carts/cA/checkout", payload: { } });
const p2 = app.inject({ method: "POST", url: "/carts/cB/checkout", payload: { } });
const [r1, r2] = await Promise.all([p1, p2]); // both target p_limited, qty 2 each
```

Both carts request 2 units of `p_limited` (stock 3). The executor serializes the two checkout tasks; exactly one commits (201) and the other sees the already-decremented inventory and fails `409 INSUFFICIENT_INVENTORY`. Final inventory is deterministically 1. No barrier or sleep is involved — FIFO ordering alone makes the assertion stable.

**The injectable hook is scoped to the `SerialExecutor` unit test only, not the hot path.** `buildApp(deps)` accepts an optional async `yieldHook(label: string)` that, in production, is a no-op and is **not** called anywhere in the checkout path (so it cannot park a task mid-critical-section — that would only create confusion, since a parked task blocks the whole executor). The hook exists solely so the `SerialExecutor` *unit* test can submit two tasks before either resolves and assert they run strictly in submission order (and that a throwing task does not break the chain). This satisfies the spec's "injectable barrier/delay hook to make concurrency tests deterministic" without placing a barrier inside a serialized task, where it would merely stall the queue.

**Rationale (resolving the earlier contradiction):** an earlier design draft placed `await yieldHook("checkout:after-validate")` *inside* the checkout task and described "pausing checkout 1, running checkout 2 to completion, then releasing checkout 1." That is impossible under this executor: while task 1 is parked at an awaited hook, the executor's tail promise has not resolved, so task 2 cannot start — it is queued, not running. The corrected model above tests real interleaving through FIFO submission (integration) and the executor's ordering contract directly (unit), neither of which requires an in-task barrier.

### 4.3 What the executor guarantees (invariants it enforces by construction)

- **I1 — No oversell:** inventory is read and decremented inside one executor task; no two checkouts can both pass the "enough inventory" check against the same stock, because the second runs only after the first has committed its decrement.
- **I2 — At-most-once checkout per cart:** the cart status transition `open → checked_out` happens inside the executor; a second checkout of the same cart sees `checked_out` and is rejected (or returns the idempotent replay — Section 7).
- **I3 — Single coupon redemption:** reserve → redeem of a coupon happens inside the executor; two concurrent checkouts cannot both move the same coupon out of `available`.
- **I4 — Milestone generated at most once:** the "has this milestone been rewarded?" check and the insert into `generatedMilestones` happen in one executor task.

## 5. Products & Inventory

### 5.1 Seed data (>= 5 products, >= 1 limited)

Defined in `config.ts`, loaded into the store at startup and on each `buildApp` in tests:

| id | name | priceCents | inventory |
|----|------|-----------|-----------|
| `p_coffee` | Bag of Coffee | 1299 | 100 |
| `p_mug` | Ceramic Mug | 850 | 100 |
| `p_grinder` | Burr Grinder | 7499 | 100 |
| `p_filters` | Paper Filters (100ct) | 599 | 100 |
| `p_scale` | Precision Scale | 3250 | 100 |
| `p_limited` | Limited Edition Tin | 2500 | **3** |

`p_limited` is the limited-inventory product used by oversell/concurrency tests.

### 5.2 Operations and validation

- `listProducts()` — read-only, returns all products with current price and inventory.
- `getProduct(id)` — read-only; `PRODUCT_NOT_FOUND` if absent.

Inventory is only mutated by checkout (decrement on success) in this design. There is no public price/inventory mutation endpoint required by the spec; however the design must still define behavior when product data *does* change (Section 6), and tests simulate a change by calling an internal store setter (`store.setProductPrice`, `store.adjustInventory`) directly inside a test. This keeps the "changed after add" scenario testable without exposing an unrequired admin mutation API. (If an admin product-edit endpoint were added later it would route through the executor like any other mutation.)

**Validation rules for anything that references a product/quantity (add/update cart item):**
- `productId`: required, string; must exist → else `PRODUCT_NOT_FOUND` (404).
- `quantity`: required, integer, `>= 1`, `<= 10000` (sanity cap) → else `INVALID_QUANTITY` (400). Non-integers, zero, and negatives are rejected (a zero quantity on *update* is treated as `INVALID_QUANTITY`; to remove a line the client uses DELETE).
- Inventory is **not** checked at add-time (only at checkout — see Section 6 decision). Add never silently drops: an invalid product or quantity fails the whole request.

## 6. Carts

### 6.1 Operations

- **Create cart** → new empty open cart.
- **Add item** → if the product already has a line, the quantities are **summed** (then re-validated against the quantity cap); otherwise a new line is appended.
- **Update quantity** → sets the absolute quantity of an existing line (must be `>= 1`).
- **Remove item** → deletes the line (idempotent: removing an absent line returns the current cart, 200, not an error — removing something that is already gone is not a failure).
- **View cart** → returns lines decorated with **current** unit price, per-line subtotal, and cart subtotal, all computed live from current product prices. View does **not** apply any coupon (coupons are a checkout-time concern).

All mutating cart ops run through the executor and require cart `status === "open"` → else `CART_ALREADY_CHECKED_OUT` (409). Unknown cart → `CART_NOT_FOUND` (404).

### 6.2 Decision — price/availability change after add, before checkout

**Decision:** Cart lines store only `{productId, quantity}`. **Price is captured at checkout from the current product price.** **Inventory is validated only at checkout**, against current inventory.

- *Viewing* a cart always reflects the product's current price (prices shown are indicative, never a quote).
- *Checkout* reads each product fresh, uses its current `priceCents` for the order snapshot, and re-validates current `inventory`.

**Rationale / alternatives considered:**
- *Capture price at add-time (price lock):* rejected — it lets the displayed cart diverge from reality and requires a quote-expiry policy the spec does not ask for; it also complicates "explain the total" because the order would use a price no longer offered.
- *Reject checkout if price changed since add:* rejected — the spec explicitly asks us to decide behavior and the simplest coherent rule is "the customer pays the current listed price," which never surprises them with a *higher* historical price and matches how most storefronts behave for an un-submitted cart.

**Consequence:** The order snapshot (Section 7) is the authoritative record of what was actually charged; the cart is a mutable draft. If inventory dropped below the requested quantity by checkout time, checkout fails with `INSUFFICIENT_INVENTORY` and the cart stays open so the client can adjust. There is no price-drift versioning or "price changed since view" warning — it is out of scope (Section 16); checkout simply uses the current price, which is always correct by this decision.

## 7. Checkout & Orders

Checkout is the critical section. Endpoint: `POST /carts/:cartId/checkout` with optional `Idempotency-Key` header and optional `{ couponCode }` body.

### 7.1 Idempotency mechanism

**Primary mechanism: `Idempotency-Key` request header.** The client SHOULD send a stable key per logical checkout attempt and reuse it on retries. A record is written **only on a committed checkout** (status is always `completed`; there is no `in_progress` state — see the Domain Model note). Dedupe logic (all inside one executor task).

**Ordering is significant: the key is checked FIRST, before the cart-status check.** When an `Idempotency-Key` is present, the key record — not the cart's status — is the authority for a retry. This ordering is deliberate (see the note below): it is what makes the key branch, and `IDEMPOTENCY_KEY_REUSED`, reachable.

1. **If `Idempotency-Key` present, look up the record by key first:**
   - `completed` + `requestFingerprint` matches → **replay** the stored response (same body, status **200**, plus header `Idempotent-Replay: true`). No new order, no inventory change, no coupon change. This satisfies "a retry must not create a second order or charge inventory twice."
   - `completed` + `requestFingerprint` **differs** (same key, different cart/coupon) → `IDEMPOTENCY_KEY_REUSED` (422). This is now reachable precisely because the key is consulted before the cart-status short-circuit: a client that reuses a key but changes the body (different cart or coupon) is caught here even though the original cart is already `checked_out`.
   - no record for the key → fall through to the cart-status check (fresh attempt; a record is written only if the checkout commits — a previously *failed* attempt left no record, so a retry proceeds cleanly).
2. **Cart-id dedupe (the floor, and the path taken when no key is present or no key record exists):** a cart whose status is already `checked_out` is handled by the header-less comparison below.

**Why the key check runs first.** A committed checkout writes the cart status (`checked_out`) and the key record (`completed`) together, atomically, inside one executor task. If the cart-status check ran first, it would short-circuit every same-cart retry before the key record was ever consulted, making the entire key branch — including `IDEMPOTENCY_KEY_REUSED` — dead code. Checking the key first means a same-key retry is answered by the key record (so the fingerprint-mismatch 422 is reachable: same key, body changed to a different cart/coupon), while the header-less comparison remains the floor for clients that omit the key. If two requests with the same key race, the executor serializes them: the first commits and writes the record, the second finds the `completed` record and replays it. If the first *fails* (no record written), the second runs as a fresh attempt — the key provides no cross-attempt protection until one attempt actually commits, which is acceptable and stated here explicitly.

**Header-less replay comparison (precise rule).** On a POST to a cart whose status is already `checked_out`:
   - Compute `requestCoupon = body.couponCode ?? null` and compare it to the stored `order.couponCode` (also `null` when the original used no coupon).
   - **Equal** → treat as an idempotent retry: return **200** with the stored order body and header `Idempotent-Replay: true`. (Includes the common case where neither the original nor the retry sent a coupon: `null === null`.)
   - **Different** → `409 CART_ALREADY_CHECKED_OUT` (a contradictory re-submit: the cart is spent and the client is asking for a materially different checkout).

**200 vs 201 is intentional.** A fresh successful checkout returns **201 Created** (a new order resource was created). An idempotent replay — whether via a matching `Idempotency-Key` record or a header-less retry of an already-checked-out cart with a matching coupon — returns **200 OK** with `Idempotent-Replay: true`, because no new resource was created on that call. This split is deliberate and documented, not an inconsistency; clients distinguish "I just created this" from "this already existed" by status + the replay header.

**Decision — header optional but recommended.** We support both because the spec names both ("Idempotency-Key header and/or dedupe on cart id"). The header is the robust path: once an attempt with the key commits, every subsequent retry carrying that key is answered by the key record regardless of the body sent, and a key reused with *different* params is caught as `IDEMPOTENCY_KEY_REUSED` rather than silently mis-replayed. Cart-id dedupe is the floor that protects clients who omit the header. One honest limitation, stated so the claim matches the mechanism: the key only begins to protect once an attempt has committed and written its record; two same-key requests that both race *and* both fail write no record and gain nothing from the key (each is a fresh attempt). This is acceptable — a checkout that never committed created no order and charged no inventory, so there is nothing to deduplicate — and is the single-process analogue of the DB `UNIQUE(key)` seam in Section 15. Documented in DECISIONS.md.

### 7.2 Checkout algorithm (single executor task)

```
run(executor):   // entire body is one serialized executor task = one critical section
  1. If Idempotency-Key present: look up record BY KEY (before any cart-status check).
     - completed + fingerprint match    -> 200 replay (7.1). Return.
     - completed + fingerprint differs  -> IDEMPOTENCY_KEY_REUSED (422). Return.
     - no record                        -> fall through (fresh attempt; record written only on commit).
     (Key first is deliberate — see 7.1 "Why the key check runs first". It keeps the
      key branch and IDEMPOTENCY_KEY_REUSED reachable: the cart-status short-circuit in
      step 2 must NOT pre-empt the key lookup, because a committed checkout writes the
      checked_out status and the completed key record together.)
  2. Load cart; must exist (else CART_NOT_FOUND 404).
     - If status == "checked_out": apply the header-less replay comparison (7.1)
       -> 200 replay OR 409 CART_ALREADY_CHECKED_OUT. Return.
       (Reached only when no key record short-circuited in step 1: either no key was
        sent, or the key is new. It is the floor for header-less clients.)
  3. Validate cart not empty -> else CART_EMPTY (422).
  4. RESERVE coupon FIRST (if couponCode supplied):   // reserve-then-commit
     a. load coupon; missing            -> COUPON_NOT_FOUND (422)
     b. status != "available"           -> COUPON_NOT_REDEEMABLE (409)
     c. set status="reserved", reservedBy=attemptId.
     (Reserving before inventory validation is deliberate: it makes the
      release/compensation path reachable and testable — see Finding-4 note below.)
  5. For each line: load product fresh.  // read/validate ONLY — no mutation here
     - product missing (removed)        -> PRODUCT_UNAVAILABLE (409)  [RELEASE coupon first]
     - inventory < quantity             -> INSUFFICIENT_INVENTORY (409) [RELEASE coupon first]
     Capture unitPriceCents = product.priceCents (current).
     NOTE: step 5 only reads and validates; it never mutates inventory (the decrement is
     step 7a). So even if an early line validates and a later line fails, no partial
     inventory side effect exists across lines — the sole compensation on any step-5
     failure is releasing the reserved coupon.
  6. Compute subtotalCents = sum(unitPriceCents * quantity);
     discountCents = clamp(round(subtotal * x / 100), 0, subtotal) (Section 9).
  7. COMMIT (all-or-nothing, still inside the same task):
     a. decrement each product.inventory by its quantity.
     b. increment global successfulOrderCount -> this order's milestoneSequence.
     c. create immutable Order snapshot (lines, name, unitPrice, qty, subtotal,
        discount, total, couponCode).
     d. if coupon reserved: set status="redeemed", redeemedByOrderId=order.id.
     e. set cart.status="checked_out", cart.orderId=order.id.
     f. if Idempotency-Key: write completed record (orderId + 201 response body).
  8. Return 201 with order body.

  On ANY failure after step 4c (coupon reserved) and before step 7 commit:
     - RELEASE the coupon reservation: status back to "available", reservedBy=null
       (compensation — coupon not consumed by a failed checkout).
     - No inventory was decremented yet (decrement is step 7a), nothing to roll back there.
     - No idempotency record was written (write is step 7f), so a retry proceeds cleanly.
```

Because the whole task runs inside the executor with **no un-awaited gaps** (there is no in-task barrier — see Section 4.2), steps 1–7 are a single atomic critical section. The reserve-then-commit ordering guarantees invariant I3: the coupon leaves `available` at step 4c and only becomes `redeemed` at 7d, or returns to `available` on any failure in between.

**Why coupon-reserve precedes inventory validation (addresses the release-path reachability concern).** With this ordering, the most common failure — `INSUFFICIENT_INVENTORY` at step 5 — occurs *with a coupon already reserved*, so it exercises the release/compensation path on a real, easily-triggered code path. The graded invariant "a coupon must not be lost or consumed by a failed checkout" is therefore testable directly: supply a valid coupon, request a quantity exceeding `p_limited` stock, assert `409 INSUFFICIENT_INVENTORY` **and** the coupon is back to `available` (Section 14). This avoids the earlier draft's problem, where reserving *after* all validation left no reachable throwing step between reservation and commit, making the release path dead.

### 7.3 Order immutability

Once created, an Order is never mutated. It snapshots `name` and `unitPriceCents` per line so it remains explainable even if the product's price/name later changes. `GET /orders/:id` is read-only.

### 7.4 Payment abstraction

**Decision:** No real payment. A trivial `payment.authorize()` function that always succeeds is **not** introduced, because adding a fake that can never fail adds surface without exercising any new invariant within the timebox. Successful validation + commit *is* treated as payment success. This is documented; the natural extension point is "insert `await payment.charge()` after step 6 (discount computed) and before step 7a (first write), and on failure run the same release/compensation path as any other pre-commit failure." Because the coupon release path is already reachable via `INSUFFICIENT_INVENTORY` (Section 7.2), the coupon-survival invariant does not depend on this seam; the seam is simply where a real payment check would slot in.

## 8. Coupons

Config: `n` (milestone interval) and `x` (percent off), from `config.ts` / env (`REWARD_N`, `REWARD_X`), defaulting to `n=5`, `x=10`.

**Config validation (fail-fast, specified).** `config.ts` exports a `loadConfig(env)` function called by `buildApp`/`server.ts` *before* the server listens. It parses `REWARD_N` and `REWARD_X` (and seed data) with a `zod` schema: `n` must be an **integer `>= 1`** (rejects `0`, which would divide-by-zero in `floor(count/n)`, and non-integers); `x` must be an **integer in `[0, 100]`** (rejects negatives, non-integers, and `>100`). On any violation `loadConfig` throws a plain `Error` with a clear message (e.g. `"invalid REWARD_N: expected integer >= 1, got '0'"`) and the process exits non-zero before accepting requests — the service never runs with invalid reward config. A unit test asserts `loadConfig` throws for `n=0`, `x=101`, and non-integer inputs, and accepts the defaults. (`x` is clamped again at discount time by the `[0, subtotal]` clamp, so even a hypothetical bad `x` could never produce a negative total, but it is rejected at load time regardless.)

### 8.1 Milestone generation (admin, idempotent)

Endpoint: `POST /admin/coupons/generate`. Runs in the executor.

```
eligibleMilestone = floor(successfulOrderCount / n) * n   // largest reached milestone
if eligibleMilestone == 0: -> NO_MILESTONE_REACHED (409)
if eligibleMilestone in generatedMilestones: -> MILESTONE_ALREADY_REWARDED (409)
else:
  create coupon { code = genCode(), percentOff = x, milestone = eligibleMilestone,
                  status="available" }
  generatedMilestones.add(eligibleMilestone)
  return 201 { coupon }
```

**Coupon code format (specified, so generated codes round-trip through accepted input).** `genCode()` returns an **uppercase** code matching the exact pattern `^SAVE-[A-Z0-9]{6}$`: the literal prefix `SAVE-` followed by 6 characters drawn from Crockford base32 alphabet `[0-9A-Z]` (ambiguous letters excluded is not required here; the generator uses `crypto.randomBytes(4)` rendered as 6 base32 chars). Example: `SAVE-5F3A2K`. The full accepted charset is therefore `[A-Z0-9-]` with the fixed `SAVE-` prefix. The code is globally unique (regenerate on the astronomically unlikely collision with an existing coupon).

Coupon lookup at checkout and the header-less replay comparison are **exact, case-sensitive** string equality with **no trimming** and no case folding. The request schema (Section 11) accepts `couponCode` only if it matches the same charset `^[A-Z0-9-]{1,64}$`; input that does not match is rejected as `VALIDATION_ERROR` (400) before any lookup, so a code can never fail to round-trip between generation, submission, and replay. One rule end-to-end: generated codes are a strict subset of accepted input, and every comparison on a code is byte-exact.

**Decision — one coupon per reached milestone, generated on demand.** The admin must call generate; a coupon is created only if the milestone is reached and not already rewarded. We reward the **largest reached-but-unrewarded** milestone per call (not auto-catch-up of all missed milestones) to keep the admin action one-coupon-per-call and the `generatedMilestones` set the single source of truth for I4. Calling generate twice for the same milestone returns `MILESTONE_ALREADY_REWARDED` — idempotent at the milestone level (the second call does not create a duplicate). This is the mechanism for "generated only once per milestone."

> **Invariant (forfeiture, explicit):** only `floor(count/n)*n` (the latest reached milestone) is offered per call. If the admin did not call generate before a later milestone was reached, the earlier milestone is **forfeited** — it can never be rewarded, because the eligibility check only ever considers the latest milestone and marks it rewarded. The hard invariant this yields: **at most `floor(ordersPlaced / n)` coupons are ever generated, and `coupons.generated <= milestonesReached`** (where `milestonesReached = floor(ordersPlaced / n)`). This is a defensible simplification: the admin is expected to call generate at each milestone, and the report surfaces `milestonesReached` so any gap between reached and generated is visible and reconcilable (Section 12). An alternative — "reward the earliest unrewarded milestone," enabling catch-up so no coupon is ever stranded — is a credible option noted in DECISIONS.md as a backlog item; it is deliberately not chosen to keep `generatedMilestones` a single, simple source of truth for I4 within the timebox.

### 8.2 Redemption semantics (decisions)

- **One coupon per order.** The checkout body accepts a single `couponCode`. Multiple coupons per order is out of scope.
- **Redeemable once.** Enforced by the `available → reserved → redeemed` state machine inside the executor (I3).
- **Reserve-then-commit / compensation.** A coupon is `reserved` at validation and only `redeemed` on commit; any failure after reservation **releases** it back to `available`. Therefore a coupon is never consumed by a failed checkout, and never permanently stuck in `reserved` (release is in the failure path of the same synchronous task; there is no cross-task window because the executor serializes).
- **Interaction with inventory failure:** the coupon is reserved *first* (step 4c), then inventory is validated (step 5) and only decremented at commit (step 7a). If inventory is insufficient, the coupon has already been reserved and the failure path **releases** it back to `available` before returning `INSUFFICIENT_INVENTORY`. This is the primary, directly-testable path for the coupon-survival invariant. Net rule: **a coupon survives any failed checkout** — it is `redeemed` only when the order actually commits.
- **Two concurrent checkouts, same coupon:** serialized by the executor; the first moves it to `reserved`/`redeemed`, the second sees `status != available` → `COUPON_NOT_REDEEMABLE` (409). They cannot both redeem (I3).
- **Discount never makes total negative:** `discountCents = min(round(subtotal * percent / 100), subtotal)`; `total = subtotal - discount >= 0`.

### 8.3 Rounding of percentage discount (decision)

**Decision:** compute discount in integer cents as `discountCents = Math.round((subtotalCents * percentOff) / 100)`, then clamp to `[0, subtotalCents]`. Rounding is **half-up** via `Math.round` on an integer-cents intermediate (the division is the only non-integer step and is immediately rounded). This is deterministic (same inputs → same output), applied to the whole-order subtotal (not per line, to avoid per-line rounding drift), and documented. Example: subtotal 1299, x=10 → `round(12990/100)=round(129.9)=130` cents off.

## 9. Money & Rounding Rules

- All monetary values are **integer cents** (`number`), never floats.
- Inputs: there are no client-supplied money inputs — prices come from seed data (already cents). Quantities are integers. So no float ever enters the money path.
- Line subtotal = `unitPriceCents * quantity` (integer × integer = integer).
- Order subtotal = sum of line subtotals (integer).
- Discount = clamp(`Math.round(subtotal * percent / 100)`, 0, subtotal) — the single rounding point, half-up.
- Total = `subtotal - discount`, guaranteed `>= 0`.
- A `money.ts` module exposes `lineSubtotal`, `sum`, `percentDiscount`, and a `formatCents` helper (for responses that also surface a human string, optional). All functions are pure and unit-testable in isolation.

## 10. HTTP API Surface

Base: no prefix. JSON everywhere. Admin endpoints are under `/admin/*` and are explicitly **unauthenticated but documented as administrative** (per spec: no auth required, just marked).

Common error body (Section 11): `{ "error": { "code": "<STABLE_CODE>", "message": "<human>", "details": <optional> } }`.

### Products
- `GET /products` → `200 [{id,name,priceCents,inventory}]`.
- `GET /products/:id` → `200 {product}` | `404 PRODUCT_NOT_FOUND`.

### Carts
- `POST /carts` → `201 {id,status:"open",lines:[],subtotalCents:0}`.
- `GET /carts/:id` → `200 {id,status,lines:[{productId,name,unitPriceCents,quantity,lineSubtotalCents}],subtotalCents}` | `404 CART_NOT_FOUND`.
- `POST /carts/:id/items` body `{productId, quantity}` → `200 {cart}` | `404 CART_NOT_FOUND|PRODUCT_NOT_FOUND` | `400 INVALID_QUANTITY|VALIDATION_ERROR` | `409 CART_ALREADY_CHECKED_OUT`.
- `PATCH /carts/:id/items/:productId` body `{quantity}` → `200 {cart}` | `404 CART_NOT_FOUND|LINE_NOT_FOUND` | `400 INVALID_QUANTITY` | `409 CART_ALREADY_CHECKED_OUT`.
- `DELETE /carts/:id/items/:productId` → `200 {cart}` (idempotent; removing absent line is OK) | `404 CART_NOT_FOUND` | `409 CART_ALREADY_CHECKED_OUT`.

### Checkout
- `POST /carts/:id/checkout`
  - headers: `Idempotency-Key` (optional, recommended).
  - body: `{ "couponCode": "<optional>" }`.
  - `201 {order}` on success (header `Idempotent-Replay` absent).
  - `200 {order}` + `Idempotent-Replay: true` on a successful idempotent replay (same key completed, or header-less retry of an already-checked-out cart with matching coupon).
  - `Idempotent-Replay` is a **response-only** header: the server sets it to `true` only on a 200 replay and omits it otherwise. Any `Idempotent-Replay` header sent by a client is ignored on input.
  - `409 CART_ALREADY_CHECKED_OUT` (contradictory re-submit) | `409 INSUFFICIENT_INVENTORY` | `409 COUPON_NOT_REDEEMABLE` | `409 PRODUCT_UNAVAILABLE` (product removed since add).
  - `422 CART_EMPTY | COUPON_NOT_FOUND | IDEMPOTENCY_KEY_REUSED`.
  - `404 CART_NOT_FOUND`.
  - `400 VALIDATION_ERROR`.

### Orders
- `GET /orders/:id` → `200 {order}` | `404 ORDER_NOT_FOUND`. Read-only.

### Admin
- `POST /admin/coupons/generate` → `201 {coupon}` | `409 NO_MILESTONE_REACHED | MILESTONE_ALREADY_REWARDED`. **Administrative.**
- `GET /admin/coupons` → `200 [{code,percentOff,milestone,status}]`. **Administrative**, read-only (useful for test assertions on coupon state).
- `GET /admin/report` → `200 {report}`. **Administrative**, strictly read-only (Section 12).

### Example — successful checkout with coupon

Request:
```
POST /carts/c_123/checkout
Idempotency-Key: ik_abc
Content-Type: application/json

{ "couponCode": "SAVE-5F3A2K" }
```
Response `201`:
```json
{
  "order": {
    "id": "o_789", "cartId": "c_123",
    "lines": [{ "productId": "p_coffee", "name": "Bag of Coffee",
                "unitPriceCents": 1299, "quantity": 2, "lineSubtotalCents": 2598 }],
    "subtotalCents": 2598, "discountCents": 260, "totalCents": 2338,
    "couponCode": "SAVE-5F3A2K", "milestoneSequence": 5,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```
Retry with same `Idempotency-Key: ik_abc` → `200`, identical body, header `Idempotent-Replay: true`.

## 11. Error Model

A single `AppError` class carries `{ code, httpStatus, message, details? }`. All domain services throw `AppError`; a Fastify `setErrorHandler` maps it to the common body (Section 10) and status. `zod` validation failures are caught and re-emitted as `VALIDATION_ERROR` (400) with field details. Unexpected errors → `500 INTERNAL_ERROR` with a generic message (no stack leaked) and are logged at `error` level.

**Stable error codes (machine-readable, enumerated in `errors.ts`):**

| code | HTTP | meaning | logged at |
|------|------|---------|-----------|
| `VALIDATION_ERROR` | 400 | malformed body/params | debug |
| `INVALID_QUANTITY` | 400 | qty not integer >= 1 (or > cap) | debug |
| `PRODUCT_NOT_FOUND` | 404 | unknown product on lookup / cart add | debug |
| `PRODUCT_UNAVAILABLE` | 409 | a product in the cart no longer exists at checkout | info |
| `CART_NOT_FOUND` | 404 | unknown cart | debug |
| `LINE_NOT_FOUND` | 404 | update of absent line | debug |
| `ORDER_NOT_FOUND` | 404 | unknown order | debug |
| `CART_EMPTY` | 422 | checkout of empty cart | info |
| `CART_ALREADY_CHECKED_OUT` | 409 | contradictory re-checkout | info |
| `INSUFFICIENT_INVENTORY` | 409 | not enough stock at checkout | info |
| `COUPON_NOT_FOUND` | 422 | unknown coupon code | info |
| `COUPON_NOT_REDEEMABLE` | 409 | coupon reserved/redeemed | info |
| `IDEMPOTENCY_KEY_REUSED` | 422 | same key, different params | warn |
| `NO_MILESTONE_REACHED` | 409 | admin generate before first milestone | info |
| `MILESTONE_ALREADY_REWARDED` | 409 | milestone coupon already generated | info |
| `INTERNAL_ERROR` | 500 | unexpected | error |

**Validation per external input:**
- `POST /carts/:id/items` body: `productId` required non-empty string; `quantity` required, `z.number().int().min(1).max(10000)`. Failure → `VALIDATION_ERROR`/`INVALID_QUANTITY` 400.
- `PATCH .../items/:productId` body: `quantity` required int `>= 1`.
- `POST .../checkout` body: `couponCode` optional; if present it must match `^[A-Z0-9-]{1,64}$` (uppercase, the same charset `genCode()` produces — Section 8.1), else `VALIDATION_ERROR` (400). The code is matched by **exact, case-sensitive** equality at lookup; no trimming or case folding is applied. `Idempotency-Key` header: optional, string, <= 200 chars; rejected if present-but-empty → `VALIDATION_ERROR`.
- Path params (`:id`, `:productId`): non-empty strings; unknown → the relevant `*_NOT_FOUND`.
- Unknown JSON fields are ignored (lenient) but body must be valid JSON (invalid JSON → 400 `VALIDATION_ERROR`).

## 12. Reporting (read-only, reconciling)

`GET /admin/report` builds a fresh snapshot from stored orders + coupons on each call and **never mutates** state (it does not go through the executor and holds no write path). Because it reads synchronously with no `await` gaps, it observes a consistent view.

Report shape:
```json
{
  "ordersPlaced": 7,
  "milestonesReached": 1,
  "purchasedQuantityByProduct": { "p_coffee": 14, "p_limited": 3 },
  "grossRevenueCents": 123456,
  "totalDiscountsCents": 2600,
  "netRevenueCents": 120856,
  "coupons": { "generated": 1, "available": 0, "reserved": 0, "redeemed": 1 },
  "config": { "n": 5, "x": 10 }
}
```

- `ordersPlaced` = count of Orders (every stored order is a successfully placed order; failures never create orders).
- `milestonesReached` = `floor(ordersPlaced / n)` — the number of reward milestones the order sequence has passed. Surfaced so the gap between milestones *reached* and coupons *generated* (which can occur because the admin must call generate per milestone, and skipped milestones are forfeited — Section 8.1) is visible and reconcilable rather than silent.
- `purchasedQuantityByProduct` = sum of `quantity` across all order lines, grouped by product.
- `grossRevenueCents` = sum of order `subtotalCents` (pre-discount).
- `totalDiscountsCents` = sum of order `discountCents`.
- `netRevenueCents` = sum of order `totalCents` = `grossRevenue - totalDiscounts` (reconciliation identity the report asserts).
- `coupons.generated` = total coupon count; `available` / `reserved` / `redeemed` = counts by status. Because coupons are created **only** by admin generation (Section 8.1) and never by any other path, `generated` equals the total number of coupon objects, and `generated === available + reserved + redeemed` is an assertable identity. A `reserved` coupon exists only transiently inside a single executor task; a read-only report call (which does not go through the executor and performs no `await` between reads) observes a consistent snapshot where no coupon is mid-transition, so `reserved` is effectively always 0 in a report — it is included in the shape for completeness and defensiveness.

**Reconciliation invariants (I5), assertable in tests:**
- `netRevenueCents === grossRevenueCents - totalDiscountsCents`.
- `coupons.redeemed === count(orders with couponCode != null)`.
- `coupons.generated === coupons.available + coupons.reserved + coupons.redeemed`.
- `coupons.generated <= milestonesReached` (a coupon is only ever generated for a reached milestone; the inequality is strict whenever a milestone was forfeited — Section 8.1).

These are assertable in a test that places orders, redeems a coupon, and compares the report to independently summed order data.

## 13. Edge Cases

- **Empty cart checkout** → `CART_EMPTY` 422.
- **Duplicate add of same product** → quantities summed, re-validated against cap.
- **Update to quantity exceeding inventory** → allowed at update time (inventory checked only at checkout); surfaces as `INSUFFICIENT_INVENTORY` at checkout.
- **Remove nonexistent line** → 200, no-op (idempotent).
- **Product price changes between add and checkout** → order uses current price (Section 6).
- **Product inventory drops below cart qty before checkout** → `INSUFFICIENT_INVENTORY`, cart stays open.
- **Checkout retry after success (same key)** → replay, 200, no new order.
- **Checkout retry without key on checked-out cart** → compare `body.couponCode ?? null` to stored `order.couponCode`: equal → 200 replay; different → 409 `CART_ALREADY_CHECKED_OUT` (Section 7.1).
- **Product removed between cart add and checkout** → `PRODUCT_UNAVAILABLE` 409 (distinct from the 404 `PRODUCT_NOT_FOUND` returned by lookups/add); any reserved coupon is released.
- **Coupon used, failed checkout** → coupon released, still `available`.
- **Two concurrent checkouts for last limited unit** → one 201, one `INSUFFICIENT_INVENTORY` 409; inventory never negative.
- **Two concurrent checkouts with same coupon** → one redeems, one `COUPON_NOT_REDEEMABLE`.
- **Admin generate before milestone** → `NO_MILESTONE_REACHED`.
- **Admin generate twice for same milestone** → first 201, second `MILESTONE_ALREADY_REWARDED`.
- **Discount >= subtotal** (e.g. large x) → total clamped to 0, never negative.

## 14. Testability

**Unit-testable in isolation (no HTTP):**
- `money.ts`: line subtotal, sum, percentage discount rounding + clamp (incl. discount >= subtotal → 0).
- Coupon state machine transitions (available→reserved→redeemed; reserved→available on release).
- Milestone computation (`floor(count/n)*n`, already-rewarded guard, forfeiture).
- `config.ts` `loadConfig`: throws for `n=0`, `x=101`, non-integer inputs; accepts defaults (Section 8).
- `SerialExecutor`: using the injected `yieldHook`, submit two tasks before either resolves and assert they run strictly in submission order; a throwing task does not break the chain (next task still runs). **This is where the injectable hook is used — in the executor unit test, not the HTTP hot path (Section 4.2).**

**Integration-testable via `app.inject()`:**
- Happy-path create cart → add → checkout → get order.
- **Oversell prevention (required competing-operations test):** seed `p_limited=3`; create two carts each with qty 2 of `p_limited`; fire both checkouts *without awaiting the first* (`const p1 = app.inject(...); const p2 = app.inject(...); await Promise.all([p1, p2])`). Assert exactly one `201` and one `409 INSUFFICIENT_INVENTORY`, and that final inventory is exactly `1` and never negative. Determinism comes from the executor's FIFO serialization — no barrier or `setTimeout` needed (Section 4.2).
- Idempotent retry: same `Idempotency-Key` twice → first 201, second 200 replay (`Idempotent-Replay: true`), one order only.
- Header-less retry on checked-out cart: same coupon → 200 replay; different/added coupon → 409 `CART_ALREADY_CHECKED_OUT`.
- Coupon single-redemption under concurrency: two carts, one coupon, both checkouts fired via `Promise.all` without awaiting → exactly one `redeemed` (201), the other `409 COUPON_NOT_REDEEMABLE`; coupon ends `redeemed`.
- **Coupon survives failed checkout (reachable path):** generate a coupon; create a cart whose `p_limited` quantity exceeds stock; checkout with the coupon → `409 INSUFFICIENT_INVENTORY` AND the coupon is back to `available` (release ran because the coupon is reserved *before* inventory validation — Section 7.2).
- Report reconciliation: place several orders incl. a discounted one → all I5 identities hold (`net = gross - discounts`; `generated = available + reserved + redeemed`; `redeemed = count(orders with coupon)`; `generated <= milestonesReached`). Assert the sum identity **including** `reserved`; do NOT assert `reserved === 0` as a standalone invariant — it holds only incidentally for the in-process model (a report call never observes a coupon mid-transition), and asserting it would create a false failure if the model ever changes.
- Milestone idempotency: place `n` orders, generate twice → first 201, second `MILESTONE_ALREADY_REWARDED`.

The `buildApp({ store, config, yieldHook })` factory makes every scenario deterministic: a fresh store + fixed config per test, FIFO serialization for competing integration tests, and the injected hook for the executor unit test. No `setTimeout`-based flakiness anywhere.

## 15. Multi-Instance / Production Evolution (documented, not implemented)

The single in-memory `SerialExecutor` guarantees the invariants only within one process. With multiple instances:
- The store moves to a shared transactional DB (e.g. Postgres).
- The serialization that the executor provides is replaced by DB transactions plus the right isolation and explicit locks: inventory decrement uses `UPDATE ... SET inventory = inventory - :q WHERE id=:id AND inventory >= :q` (conditional update, oversell-safe); coupon redemption uses a conditional `UPDATE coupons SET status='redeemed' WHERE code=:c AND status='available'` and checks affected-rows for single-redemption; idempotency records get a `UNIQUE(key)` constraint so a retry collides deterministically.
- The milestone/order counter becomes a DB sequence or a `SELECT ... FOR UPDATE` on a counter row to keep I4.
- Reporting becomes aggregate SQL (still read-only).

This mapping is intentional: the application-level invariants (I1–I5) are expressed so each one has a direct DB-level enforcement counterpart, so moving to multi-instance is a change of enforcement layer, not of domain logic.

## 16. Out of Scope

- Authentication / authorization (spec: not required; admin endpoints merely documented as such).
- Real payment integration (treated as success; seam documented).
- Public product price/inventory mutation API (not required; tests mutate via store setters).
- Catch-up generation of multiple skipped milestones in one call (only latest milestone rewarded per call; alternative noted).
- Persistence across restarts; horizontal scaling implementation (design-level mapping only, Section 15).
- Per-line (vs whole-order) discount allocation; multiple coupons per order; cart-level price-lock / quote expiry; "price changed" warnings on cart view.

## 17. Assumptions

- `n` is an integer `>= 1` and `x` is an integer in `[0, 100]`. This is **enforced** by `loadConfig` in `config.ts` with a `zod` schema that throws before the server listens (Section 8), not merely assumed.
- A "successfully placed order" = an Order stored by a committed checkout. This is the counter driving milestones and the number reported as `ordersPlaced`.
- Coupon codes are server-generated, globally unique strings.
- Clients are trusted to send JSON; no rate limiting or payload-size hardening beyond basic field limits (out of scope for the timebox).
- One cart maps to at most one order.

## 18. Responses to Design Review

### 18.1 Round 1 review (2 HIGH, 5 MEDIUM, 3 NIT)

This subsection records how each finding in the first-round review was handled. All findings are **addressed**; none backlogged or ignored.

**Finding 1 (HIGH) — concurrency test infeasible with serial executor. ADDRESSED (Option A).** Section 4.2 was rewritten: the in-task `yieldHook("checkout:after-validate")` barrier is removed from the checkout path entirely (a parked task would only stall the whole executor). The required competing-operations test now relies on FIFO serialization — two checkouts submitted via `Promise.all` without awaiting the first — which is deterministic without any barrier. The `yieldHook` is retained *only* for the `SerialExecutor` unit test (ordering + throw-safety). Section 14's required test is restated verbatim to match this mechanism.

**Finding 2 (HIGH) — `in_progress` / `IDEMPOTENCY_CONFLICT` unreachable. ADDRESSED (simplify).** The `IdempotencyRecord` now has only a `completed` status; a record is written solely on commit (step 7f). A failed attempt writes no record, so retries proceed cleanly. `IDEMPOTENCY_CONFLICT` is removed from Sections 7.1, 7.2, and the error table. The multi-instance window (where a DB `UNIQUE(key)` constraint does produce a real conflict) is noted as the Section 15 seam.

**Finding 3 (MEDIUM) — one code, two HTTP statuses. ADDRESSED (split).** `PRODUCT_NOT_FOUND` is now 404 only (lookups / cart add). A new `PRODUCT_UNAVAILABLE` (409) covers the checkout-time "product removed since add" case. Updated in Section 7.2 step 5, Section 10 checkout errors, Section 11 error table, and Section 13.

**Finding 4 (MEDIUM) — coupon release path unreachable. ADDRESSED (reorder).** The coupon is now reserved **before** inventory validation (Section 7.2: step 4 reserve, step 5 inventory). The common `INSUFFICIENT_INVENTORY` failure therefore occurs with a coupon already reserved and exercises the release/compensation path. Section 14's coupon-survival test is now concrete: over-request `p_limited` stock with a coupon, assert 409 and coupon back to `available`. Sections 7.2, 7.4, 8.2 updated.

**Finding 5 (MEDIUM) — header-less replay status + coupon-match underspecified. ADDRESSED.** Section 7.1 now defines the comparison precisely (`body.couponCode ?? null` vs stored `order.couponCode ?? null`; equal → 200 replay, different → 409), covers the no-coupon-both-times case (`null === null`), and explicitly documents the 200-vs-201 split as intentional. Mirrored in Section 13.

**Finding 6 (MEDIUM) — milestone stranding + report can't reconcile. ADDRESSED (both).** (a) Section 8.1 states the forfeiture invariant explicitly (`coupons.generated <= floor(ordersPlaced/n)`) and keeps the "latest milestone only" rule, naming the catch-up alternative as a backlog option. (b) Section 12 adds `milestonesReached = floor(ordersPlaced / n)` to the report and makes `coupons.generated <= milestonesReached` an assertable reconciliation identity.

**Finding 7 (MEDIUM) — config validation unspecified. ADDRESSED.** Section 8 now specifies `loadConfig(env)` in `config.ts`: `zod` schema enforcing `n` integer `>= 1` and `x` integer in `[0,100]`, throwing before the server listens, with a named unit test. Referenced from Section 2 (layout), Section 14 (tests), and Section 17 (assumptions now say "enforced", not "assumed").

**Finding 8 (NIT) — unused `version` field. ADDRESSED (delete).** `Product.version` is removed from the Domain Model (Section 3), Section 5.2, and Section 6.2. The design never blocks on drift, so the field had no consumer.

**Finding 9 (NIT) — report `coupons.generated` identity implicit. ADDRESSED.** Section 12 now states that because coupons are created only by admin generation, `generated === available + reserved + redeemed` is an assertable identity, and lists it among the I5 reconciliation checks.

**Finding 10 (NIT) — fingerprint hash unspecified. ADDRESSED.** `requestFingerprint` is now defined as the plain delimiter-joined string `` `${cartId}|${couponCode ?? ""}` `` compared by equality (no hashing dependency). Updated in Section 3; Sections 7.1/7.2 reference it consistently.

### 18.2 Round 2 review (1 HIGH, 3 MEDIUM, 2 NIT)

This subsection records how each finding in the second-round review (`design-review.md`, verdict CHANGES_REQUESTED) was handled. All findings are **addressed**; none backlogged or ignored.

**Finding 1 (HIGH) — the `Idempotency-Key` branch and `IDEMPOTENCY_KEY_REUSED` were unreachable because the cart-status check (step 1) ran before the key lookup (step 2). ADDRESSED (reorder, per the review's concrete fix).** Section 7.2 now runs the **key lookup first** (new step 1) and the cart-load + checked-out comparison **second** (new step 2). The algorithm block carries an inline note explaining why the key must precede the cart-status short-circuit (both are written together at commit, so the status check would otherwise pre-empt every same-cart retry). Section 7.1 was rewritten to make the ordering explicit, add a "Why the key check runs first" paragraph, and state that the key is the authority when present while the header-less comparison is the floor. The `IDEMPOTENCY_KEY_REUSED` (422) path is now reachable: same key + body changed to a different cart/coupon, caught at step 1 even though the original cart is `checked_out`. Section 3 was updated so the record stores only the order body (replay status is always 200 by construction, not stored).

**Finding 2 (MEDIUM) — "survives retries even before an order exists" overstated; racing-retry behavior unspecified. ADDRESSED.** With the Finding‑1 reordering, the key record is the authority for same-key retries. Section 7.1's "Why the key check runs first" paragraph now states the race behavior precisely: the executor serializes two same-key requests; the first commits and writes the record, the second replays it; if the first fails (no record written), the second runs as a fresh attempt. The "Decision — header optional but recommended" paragraph was rewritten to drop the overstated "even before an order exists" claim and replace it with the honest limitation (the key protects only once an attempt has committed), noting the DB `UNIQUE(key)` seam (Section 15) as the multi-instance counterpart.

**Finding 3 (MEDIUM) — step-5 read/validate-only behavior not stated; partial-side-effect ambiguity across lines. ADDRESSED.** Section 7.2 step 5 now carries an explicit NOTE: step 5 only reads and validates and never mutates inventory (the decrement is step 7a), so no partial inventory side effect can exist across lines, and the sole compensation on any step‑5 failure is releasing the reserved coupon.

**Finding 4 (MEDIUM) — coupon code format / normalization underspecified; generated-vs-accepted mismatch risk. ADDRESSED.** Section 8.1 now specifies `genCode()` exactly: uppercase `^SAVE-[A-Z0-9]{6}$` (prefix `SAVE-` + 6 Crockford-base32 chars from `crypto.randomBytes(4)`), globally unique with regenerate-on-collision. It states that coupon lookup and the header-less replay comparison are exact, case-sensitive equality with no trimming or case folding, and that the request schema accepts only `^[A-Z0-9-]{1,64}$`, so generated codes are a strict subset of accepted input and round-trip end to end. Section 11's `couponCode` validation rule was updated to the same charset and matching semantics. The two illustrative `SAVE-5F3A` codes in the Section 10 example were corrected to `SAVE-5F3A2K` to satisfy the 6-char pattern.

**Finding 5 (NIT) — `Idempotent-Replay` direction not defined. ADDRESSED.** Section 10's checkout entry now states `Idempotent-Replay` is a response-only header, set to `true` only on a 200 replay and omitted otherwise, and that any client-sent value is ignored on input.

**Finding 6 (NIT) — report `reserved === 0` risked becoming a false-failure invariant. ADDRESSED.** Section 14's report-reconciliation test note now says to assert the sum identity **including** `reserved` but NOT to assert `reserved === 0` as a standalone invariant, since it holds only incidentally for the in-process model.
