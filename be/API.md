# API Reference

Reliable Checkout and Rewards Service. JSON over HTTP, no path prefix. The base
URL is `http://localhost:3000` by default (configurable via `PORT` / `HOST`).

All request bodies are `application/json`. All responses are JSON.

## Conventions

### Error body

Every error returns the same shape, with a stable machine-readable `code`:

```json
{ "error": { "code": "<STABLE_CODE>", "message": "<human readable>", "details": <optional> } }
```

`details` is present only for some errors (for example, `VALIDATION_ERROR`
carries the offending fields). Clients should branch on `error.code`, not on the
message text.

### Stable error codes

| code | HTTP | meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | malformed body/params (also raised by zod schema failures) |
| `INVALID_QUANTITY` | 400 | quantity is not an integer `>= 1`, or exceeds the cap (10000) |
| `PRODUCT_NOT_FOUND` | 404 | unknown product on lookup or cart add |
| `PRODUCT_UNAVAILABLE` | 409 | a product in the cart no longer exists at checkout |
| `CART_NOT_FOUND` | 404 | unknown cart |
| `LINE_NOT_FOUND` | 404 | update of a line that is not in the cart |
| `ORDER_NOT_FOUND` | 404 | unknown order |
| `CART_EMPTY` | 422 | checkout of an empty cart |
| `CART_ALREADY_CHECKED_OUT` | 409 | contradictory re-checkout of a spent cart |
| `INSUFFICIENT_INVENTORY` | 409 | not enough stock at checkout |
| `COUPON_NOT_FOUND` | 422 | unknown coupon code supplied at checkout |
| `COUPON_NOT_REDEEMABLE` | 409 | coupon is already reserved or redeemed |
| `IDEMPOTENCY_KEY_REUSED` | 422 | same `Idempotency-Key`, different request params |
| `NO_MILESTONE_REACHED` | 409 | admin coupon generate before the first milestone |
| `MILESTONE_ALREADY_REWARDED` | 409 | the eligible milestone already has a coupon |
| `INTERNAL_ERROR` | 500 | unexpected error (generic message, no stack leaked) |

### Administrative endpoints

Endpoints under `/admin/*` are **administrative**. Authentication and
authorization are intentionally not implemented (per the assignment); these
routes are simply identified as the operations an administrator would perform.
They are marked **Administrative** below.

### Money

All monetary values are integer **cents** (`priceCents`, `subtotalCents`,
`discountCents`, `totalCents`, ...). There are no floating-point money fields.

---

## Products

### GET /products

List all products with current price and inventory. Read-only.

- Request: no params, no body.
- Response `200`:

```json
[
  { "id": "p_coffee", "name": "Bag of Coffee", "priceCents": 1299, "inventory": 100 },
  { "id": "p_limited", "name": "Limited Edition Tin", "priceCents": 2500, "inventory": 3 }
]
```

### GET /products/:id

Fetch a single product. Read-only.

- Path params: `id` — product id.
- Response `200`:

```json
{ "product": { "id": "p_coffee", "name": "Bag of Coffee", "priceCents": 1299, "inventory": 100 } }
```

- Errors: `404 PRODUCT_NOT_FOUND`.

---

## Carts

A cart view (`CartView`) is:

```json
{
  "id": "<uuid>",
  "status": "open",
  "lines": [
    { "productId": "p_coffee", "name": "Bag of Coffee", "unitPriceCents": 1299, "quantity": 2, "lineSubtotalCents": 2598 }
  ],
  "subtotalCents": 2598
}
```

Prices in a cart view are computed live from the **current** product price; they
are indicative, never a quote. The price actually charged is captured at
checkout (see [DECISIONS.md](./DECISIONS.md)).

### POST /carts

Create a new empty, open cart.

- Request: no body.
- Response `201`:

```json
{ "id": "<uuid>", "status": "open", "lines": [], "subtotalCents": 0 }
```

### GET /carts/:id

View a cart with current prices and totals. Read-only.

- Path params: `id` — cart id.
- Response `200`: a `CartView`.
- Errors: `404 CART_NOT_FOUND`.

### POST /carts/:id/items

Add an item to a cart. If a line for the product already exists, the quantities
are **summed** (then re-validated against the cap).

- Path params: `id` — cart id.
- Body: `{ "productId": "p_coffee", "quantity": 2 }`
  - `productId`: required non-empty string.
  - `quantity`: required integer, `>= 1`, `<= 10000`.
- Response `200`: the updated `CartView`.
- Errors:
  - `404 CART_NOT_FOUND` — unknown cart.
  - `404 PRODUCT_NOT_FOUND` — unknown product.
  - `400 INVALID_QUANTITY` — quantity not an integer `>= 1` or above the cap.
  - `400 VALIDATION_ERROR` — malformed body.
  - `409 CART_ALREADY_CHECKED_OUT` — the cart has been checked out.

Inventory is **not** checked at add time; it is validated only at checkout.

### PATCH /carts/:id/items/:productId

Set the absolute quantity of an existing line.

- Path params: `id` — cart id; `productId` — product id of the line.
- Body: `{ "quantity": 3 }`
  - `quantity`: required integer, `>= 1`.
- Response `200`: the updated `CartView`.
- Errors:
  - `404 CART_NOT_FOUND` — unknown cart.
  - `404 LINE_NOT_FOUND` — the cart has no line for that product.
  - `400 INVALID_QUANTITY` / `400 VALIDATION_ERROR` — bad quantity.
  - `409 CART_ALREADY_CHECKED_OUT`.

### DELETE /carts/:id/items/:productId

Remove a line from a cart. **Idempotent**: removing a line that is not present
returns the current cart (200), not an error.

- Path params: `id` — cart id; `productId` — product id.
- Response `200`: the updated `CartView`.
- Errors:
  - `404 CART_NOT_FOUND` — unknown cart.
  - `409 CART_ALREADY_CHECKED_OUT`.

---

## Checkout

### POST /carts/:id/checkout

Validate the cart and, on success, create an immutable order. This is the
critical section; it runs as a single serialized task (see
[DECISIONS.md](./DECISIONS.md)).

- Path params: `id` — cart id.
- Headers:
  - `Idempotency-Key` — optional, recommended. String, `1..200` chars. If
    present-but-empty, the request is rejected with `400 VALIDATION_ERROR`.
    Reusing a key with the same cart/coupon replays the original result;
    reusing it with different params is rejected (see below).
- Body: `{ "couponCode": "SAVE-5F3A2K" }`
  - `couponCode`: optional. If present, must match `^[A-Z0-9-]{1,64}$`
    (uppercase; the same charset coupon codes are generated with). Matched by
    exact, case-sensitive equality; no trimming or case folding.
- Response `201` on a fresh success (no `Idempotent-Replay` header):

```json
{
  "order": {
    "id": "<uuid>",
    "cartId": "<uuid>",
    "lines": [
      { "productId": "p_coffee", "name": "Bag of Coffee", "unitPriceCents": 1299, "quantity": 2, "lineSubtotalCents": 2598 }
    ],
    "subtotalCents": 2598,
    "discountCents": 260,
    "totalCents": 2338,
    "couponCode": "SAVE-5F3A2K",
    "milestoneSequence": 5,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

- Response `200` + header `Idempotent-Replay: true` on a successful idempotent
  replay — either a retry carrying a completed `Idempotency-Key`, or a
  header-less retry of an already-checked-out cart whose supplied coupon matches
  the original. The body is identical to the original `201` body.
  - `Idempotent-Replay` is a **response-only** header. The server sets it to
    `true` only on a 200 replay and omits it otherwise. Any value a client sends
    on the request is ignored.
- Errors:
  - `400 VALIDATION_ERROR` — malformed body or an invalid `couponCode` / empty `Idempotency-Key`.
  - `404 CART_NOT_FOUND` — unknown cart.
  - `409 CART_ALREADY_CHECKED_OUT` — a contradictory re-submit of a spent cart (different coupon than the original, no key).
  - `409 INSUFFICIENT_INVENTORY` — a line's quantity exceeds current stock.
  - `409 PRODUCT_UNAVAILABLE` — a product in the cart no longer exists at checkout.
  - `409 COUPON_NOT_REDEEMABLE` — the supplied coupon is already reserved/redeemed.
  - `422 CART_EMPTY` — the cart has no lines.
  - `422 COUPON_NOT_FOUND` — the supplied coupon code does not exist.
  - `422 IDEMPOTENCY_KEY_REUSED` — the same key was used with a different cart/coupon.

**Status split (intentional).** A fresh checkout returns `201 Created`; an
idempotent replay returns `200 OK` + `Idempotent-Replay: true`, because no new
resource was created on that call.

**Coupon safety.** A coupon is reserved before inventory is validated and only
redeemed on commit. Any pre-commit failure (for example `INSUFFICIENT_INVENTORY`)
releases the coupon back to `available`, so a failed checkout never consumes a
coupon.

---

## Orders

### GET /orders/:id

Fetch an order. Orders are immutable snapshots and remain explainable even if
product data later changes. Read-only.

- Path params: `id` — order id.
- Response `200`: `{ "order": { ... } }` (same shape as the checkout response).
- Errors: `404 ORDER_NOT_FOUND`.

---

## Admin

All endpoints below are **Administrative**.

### POST /admin/coupons/generate  — Administrative

Generate a coupon for the largest reached-but-unrewarded order milestone
(`floor(ordersPlaced / n) * n`). Idempotent at the milestone level: a second
call for the same milestone does not create a duplicate.

- Request: no body.
- Response `201`:

```json
{
  "coupon": {
    "code": "SAVE-5F3A2K",
    "percentOff": 10,
    "milestone": 5,
    "status": "available",
    "redeemedByOrderId": null,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

- Errors:
  - `409 NO_MILESTONE_REACHED` — no milestone reached yet (`ordersPlaced < n`).
  - `409 MILESTONE_ALREADY_REWARDED` — the eligible milestone already has a coupon.

### GET /admin/coupons  — Administrative

List all coupons as summaries, including status. Read-only. Returns a **bare
array** (not wrapped in an object).

- Request: no params, no body.
- Response `200`:

```json
[
  { "code": "SAVE-5F3A2K", "percentOff": 10, "milestone": 5, "status": "redeemed" }
]
```

### GET /admin/report  — Administrative

Return a reconciling summary built fresh from stored orders and coupons on every
call. Strictly read-only; it never mutates state and does not go through the
serial executor.

- Request: no params, no body.
- Response `200`:

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

Reconciliation identities the report always satisfies:

- `netRevenueCents === grossRevenueCents - totalDiscountsCents`
- `coupons.generated === coupons.available + coupons.reserved + coupons.redeemed`
- `coupons.redeemed === count(orders with couponCode != null)`
- `coupons.generated <= milestonesReached`

Repeated report requests do not mutate state.

---

## Executable examples (curl)

```bash
BASE=http://localhost:3000

# List products
curl -s $BASE/products

# Create a cart (capture the returned id)
CART=$(curl -s -X POST $BASE/carts | python -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# Add 2 bags of coffee
curl -s -X POST $BASE/carts/$CART/items \
  -H 'Content-Type: application/json' \
  -d '{"productId":"p_coffee","quantity":2}'

# View the cart
curl -s $BASE/carts/$CART

# Checkout with an idempotency key (retry-safe)
curl -s -X POST $BASE/carts/$CART/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: ik_demo_1' \
  -d '{}'

# Admin: inspect the report
curl -s $BASE/admin/report
```
