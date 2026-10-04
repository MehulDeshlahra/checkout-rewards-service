# Implementation Plan — Reliable Checkout and Rewards Service

Implements `be/.agents/tasks/design.md` (approved) with the 5 open findings + 2 NITs from
`be/.agents/tasks/design-review.md` folded in. All paths absolute under
`c:\Users\mehul\Desktop\assignment\assignment\be`. Stack is LOCKED: TypeScript (strict) +
Node >=20, Fastify, in-memory `Map`s, Vitest (`npm test` = `vitest run`), integer cents, zod,
EXACT pinned deps. Mutations run through one `SerialExecutor`; reads are synchronous snapshot
builders. Sequence supports incremental commits; stage specific files only (never `git add -A`);
do NOT push, do NOT open a PR, do NOT touch git config.

Design-review findings mapped to the items that discharge them:
- F1 (HIGH, report snapshot sync + concurrent-report test) -> items 8, 9.
- F2 (order count = `orders.size`, `milestoneSequence = orders.size` after insert) -> items 5, 6.
- F3 (fingerprint = `cartId|couponCode`, document immutable-cart assumption) -> items 5, 11.
- F4 (remove dead `reservedBy`) -> items 2, 6, 11.
- F5 (`crypto.randomUUID()` ids; tests capture returned ids) -> items 2, 4, 9.
- NIT a (checkout handler calls `executor.run(...)` with no preceding `await`) -> items 5, 9.
- NIT b (admin coupons list includes `status`) -> items 7, 9.

---

- [ ] 1. Scaffold the project: `package.json` (type:module, scripts `build`=`tsc -p tsconfig.json`,
      `test`=`vitest run`, `dev`=`tsx src/server.ts`, `start`=`tsx src/server.ts`; EXACT pinned
      versions, no `^`/`~`, deps `fastify` + `zod`, devDeps `typescript` `vitest` `@types/node` `tsx`),
      `tsconfig.json` (strict, NodeNext, outDir `dist`, target ES2022), `vitest.config.ts`, and a
      `.gitignore` (node_modules, dist). Do NOT modify README.md.
      Files: `c:\...\be\package.json`, `c:\...\be\tsconfig.json`, `c:\...\be\vitest.config.ts`, `c:\...\be\.gitignore`
      Verify: `npm install` succeeds; `npm run build` exits 0 (compiles empty/placeholder `src`); `npm test` runs (0 tests OK).

- [ ] 2. Domain types + error registry + money module. `domain/types.ts` (Product, CartLine, Cart,
      OrderLine, Order with `milestoneSequence`, Coupon WITHOUT `reservedBy` [F4], IdempotencyRecord
      with `requestFingerprint`, Report). `errors.ts` (`AppError{code,httpStatus,message,details?}` +
      full `ERROR_CODES` registry/status map from design Section 11). `money.ts` (`lineSubtotal`, `sum`,
      `percentDiscount` = clamp(Math.round(subtotal*x/100),0,subtotal), `formatCents`) — pure, integer-only.
      Ids via `crypto.randomUUID()` helper [F5].
      Files: `c:\...\be\src\domain\types.ts`, `c:\...\be\src\errors.ts`, `c:\...\be\src\money.ts`
      Verify: `npm run build` exits 0; add `test/money.test.ts` (rounding half-up e.g. 1299*10->130; clamp discount>=subtotal->0; no float). `npx vitest run test/money.test.ts` passes.

- [ ] 3. Store + SerialExecutor + config. `store/store.ts` (plain Maps: products, carts, orders,
      coupons, idempotency; `generatedMilestones:Set<number>`; test setters `setProductPrice`,
      `adjustInventory`, `removeProduct`). `store/executor.ts` (`SerialExecutor` promise-chain from
      design 4.1). `config.ts` (`loadConfig(env)` zod: `n` int>=1, `x` int [0,100], throw before listen;
      seed >=5 products incl. `p_limited` inventory 3).
      Files: `c:\...\be\src\store\store.ts`, `c:\...\be\src\store\executor.ts`, `c:\...\be\src\config.ts`
      Verify: add `test/executor.test.ts` (two tasks submitted before either resolves run in FIFO order; throwing task doesn't break chain) + `test/config.test.ts` (throws n=0, x=101, non-int; accepts defaults). `npx vitest run test/executor.test.ts test/config.test.ts` passes.

- [ ] 4. Products + Carts services + HTTP app factory + routes. `domain/products.ts`
      (`listProducts`, `getProduct`), `domain/carts.ts` (create/add[sum qty]/updateQty/remove[idempotent]/
      view with live prices+totals; mutations via executor; validation per design 5.2/6.1).
      `http/app.ts` (`buildApp({store,config,yieldHook?})`), `http/error-handler.ts` (AppError + zod ->
      body/status), `http/routes/products.ts`, `http/routes/carts.ts`, `server.ts`. Ids via `randomUUID()` [F5].
      Files: `c:\...\be\src\domain\products.ts`, `c:\...\be\src\domain\carts.ts`, `c:\...\be\src\http\app.ts`, `c:\...\be\src\http\error-handler.ts`, `c:\...\be\src\http\routes\products.ts`, `c:\...\be\src\http\routes\carts.ts`, `c:\...\be\src\server.ts`
      Verify: add `test/carts.test.ts` (create via API capturing returned id; add/sum/update/remove/view totals; invalid product 404, invalid qty 400). `npx vitest run test/carts.test.ts` passes; `npm run build` exits 0.

- [ ] 5. Checkout + orders service with idempotency. `domain/checkout.ts` implementing design 7.2 as ONE
      executor task: key lookup FIRST (fingerprint `cartId|couponCode` [F3]) -> replay/REUSED; cart load +
      checked-out header-less comparison; empty check; reserve coupon; validate+capture prices (no mutation);
      compute money; commit (decrement inventory, insert order, set `milestoneSequence = orders.size` AFTER
      insert [F2], redeem coupon, mark cart, write idempotency record on commit only). Release coupon on any
      pre-commit failure. `http/routes/checkout.ts` + `http/routes/orders.ts`; handler calls
      `executor.run(...)` with NO preceding `await` [NIT a]. `GET /orders/:id` read-only.
      Files: `c:\...\be\src\domain\checkout.ts`, `c:\...\be\src\http\routes\checkout.ts`, `c:\...\be\src\http\routes\orders.ts`
      Verify: add `test/checkout.test.ts` (happy path 201 + order snapshot; empty cart 422; insufficient inventory 409; idempotent same-key retry -> one order, replay 200 Idempotent-Replay:true; header-less same-coupon replay vs different-coupon 409). `npx vitest run test/checkout.test.ts` passes.

- [ ] 6. Coupons service. `domain/coupons.ts`: `genCode()` (`^SAVE-[A-Z0-9]{6}$`), admin generate
      (eligible = floor(orders.size/n)*n [F2]; NO_MILESTONE_REACHED / MILESTONE_ALREADY_REWARDED; add to
      `generatedMilestones`), reserve/release/redeem state machine (available->reserved->redeemed; no
      `reservedBy` [F4]). Wire reserve/redeem/release into checkout (item 5). `http/routes/admin.ts`:
      `POST /admin/coupons/generate`, `GET /admin/coupons` returning `{code,percentOff,milestone,status}` [NIT b].
      Files: `c:\...\be\src\domain\coupons.ts`, `c:\...\be\src\http\routes\admin.ts`
      Verify: add `test/coupons.test.ts` (generate at milestone 201; generate again MILESTONE_ALREADY_REWARDED; generate before milestone NO_MILESTONE_REACHED; checkout with coupon applies discount+redeems). `npx vitest run test/coupons.test.ts` passes; `npm run build` exits 0.

- [ ] 7. Reporting (read-only, snapshot-consistent). `domain/reporting.ts` exposes a FULLY SYNCHRONOUS
      `buildReport(store,config)` (rule R-REPORT-SYNC: read orders/coupons/config/counter into locals with
      NO `await`, then aggregate) [F1]. Shape per design 12: ordersPlaced=`orders.size`, milestonesReached,
      purchasedQuantityByProduct, gross/discounts/net, coupons{generated,available,reserved,redeemed}, config.
      Add `GET /admin/report` to `http/routes/admin.ts`; handler may be async but performs no `await` between
      the builder's reads.
      Files: `c:\...\be\src\domain\reporting.ts`, `c:\...\be\src\http\routes\admin.ts`
      Verify: add `test/report.test.ts` (place several orders incl. discounted; assert net=gross-discounts, generated=available+reserved+redeemed, redeemed=count(orders with coupon), generated<=milestonesReached). `npx vitest run test/report.test.ts` passes.

- [ ] 8. Concurrency + failure-mode tests (deterministic via executor FIFO, no sleeps). `test/concurrency.test.ts`:
      (a) two carts qty2 of `p_limited`(3), fire both checkouts via `Promise.all` WITHOUT awaiting -> exactly one
      201 + one 409 INSUFFICIENT_INVENTORY, final inventory 1; (b) two carts one single-use coupon fired via
      `Promise.all` -> exactly one 201, coupon ends `redeemed` exactly once; (c) coupon NOT consumed by failed
      checkout (over-request stock with coupon -> 409 and coupon back to `available`). All carts created via API,
      ids captured [F5].
      Files: `c:\...\be\test\concurrency.test.ts`
      Verify: `npx vitest run test/concurrency.test.ts` passes.

- [ ] 9. Report-under-concurrency reconciliation test [F1]. `test/report-concurrency.test.ts`: fire a
      `GET /admin/report` concurrently with a committing checkout via the same `Promise.all` pattern; assert all
      reconciliation identities still hold (net=gross-discounts; generated=available+reserved+redeemed;
      redeemed=count(orders with couponCode); generated<=milestonesReached). Confirm checkout handler has no
      pre-`await` before `executor.run` [NIT a] and admin coupons list exposes `status` [NIT b].
      Files: `c:\...\be\test\report-concurrency.test.ts`
      Verify: `npx vitest run` — full suite green (`npm test`).

- [ ] 10. API documentation. Create `API.md` documenting every endpoint (method, path, request, response,
      status codes, important error cases, marking `/admin/*` as administrative). APPEND a Setup/Run/Seed/API
      section to README.md WITHOUT altering the original assignment text above it (optionally link API.md).
      Files: `c:\...\be\API.md`, `c:\...\be\README.md` (append only)
      Verify: `npm run build` + `npm test` still green; visually confirm original README assignment text is intact and a documented seed-loaded start command (`npm run dev`/`npm start`) is present.

- [ ] 11. DECISIONS.md (REQUIRED, heavily weighted). Cover: invariants (I1-I5); ambiguities + chosen semantics
      (price-at-checkout; idempotency fingerprint `cartId|couponCode` + immutable-cart/1:1-key assumption [F3];
      coupon reserve-then-commit; milestone forfeiture); >=5 material decisions in Context/Options/Choice/Why/
      Consequences; SerialExecutor concurrency+idempotency strategy; money+rounding rules; error model (code
      registry + status map); implemented vs deferred; multi-instance + production-DB evolution (where
      `reservedBy`/a txn id reappears [F4], DB `UNIQUE(idempotency key)` seam); how AI tools were used INCLUDING
      the concrete correction example (design-review caught the infeasible in-task-yield-barrier concurrency test;
      re-specified around FIFO executor ordering); what to examine first given another 2 hours; ~4-6h time spent.
      Files: `c:\...\be\DECISIONS.md`
      Verify: `npm test` green; manual checklist — every required DECISIONS.md section present, >=5 decisions in the Context/Options/Choice/Why/Consequences format, the AI correction example included.

---

## Suggested commit sequence
scaffold (1) -> store+money+types+errors (2,3) -> products/carts (4) -> checkout+idempotency (5) ->
coupons (6) -> reporting (7) -> tests (8,9) -> docs+DECISIONS (10,11). Each item leaves the tree
buildable (`npm run build`) and tests green (`npm test`). Stage only the files listed per item.

## Assumptions / gaps
- No test fixtures reference literal cart/order ids; all ids come from `crypto.randomUUID()` and tests
  capture returned ids (determinism comes from executor FIFO on checkouts, per F5).
- `GET /admin/report` stays off the executor; snapshot consistency rests on R-REPORT-SYNC (F1), verified
  by the concurrent-report test (item 9).
- README.md original assignment text is preserved; implementation only appends setup/run/API sections.
