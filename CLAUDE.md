# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start server with --watch (auto-restarts on file changes)
npm start          # Start server (production)
npm test           # Run Jest test suite
npx jest -t "test name"   # Run a single test by name
npx jest tests/server.test.js  # Run a specific test file
```

Tests use Jest + Supertest against a fully mocked environment (no real DB/Stripe/Resend needed). The mock setup is in `tests/setup.js`. The rate limiter on `/create-checkout-session` skips itself when `NODE_ENV=test`.

## Environment Variables

Required in `.env` (never committed):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `ADMIN_PASSWORD` | Password for `/admin` login |
| `ADMIN_EMAIL` | Receives admin notification emails |
| `SESSION_SECRET` | Express session secret |
| `RESEND_API_KEY` | Resend email API key |
| `RESEND_FROM_DOMAIN` | Email sender domain (e.g. `creamybits.com`) |
| `R2_ACCOUNT_ID` | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET` | R2 bucket name |
| `R2_PUBLIC_URL` | Public base URL for R2 images |
| `BASE_URL` | Server base URL (e.g. `https://creamybits.onrender.com`) |

## Architecture

Single-file Express backend (`server.js`, ~1300 lines) serving static HTML/CSS/JS frontends from `public/`. No frontend build step. `server.js` contains all DB helpers, route handlers, email logic, and R2 upload logic.

**Critical middleware ordering**: The Stripe webhook route (`POST /stripe-webhook`) must come _before_ `express.json()` in `server.js` because it needs the raw `Buffer` body for Stripe signature verification. Inserting middleware between these will break webhook processing.

`server.js` only calls `app.listen()` and `initDB()` when `require.main === module` — this is how Jest imports the app without starting a server or hitting the DB.

### Data flow

1. Customer browses `public/index.html` → fetches `/products` + `/deals` → adds to cart → fills checkout form → `POST /create-checkout-session` → redirected to Stripe hosted checkout
2. On payment, Stripe fires `checkout.session.completed` → `POST /stripe-webhook` → order status set to `'paid'`, confirmation email sent via Resend
3. Admin at `/admin` (protected by session) views `public/admin.html` → fetches orders, products, blocked dates, deals, Luxe items

### Database tables

- **`orders`** — customer orders. Key fields: `status` (`pending_payment`/`paid`/`cancelled`/`completed`), `pickup_status` (`pending`/`ready`/`picked_up`), `pickup_date` (ISO `YYYY-MM-DD`), `pickup_day` (legacy `Saturday`/`Sunday`), `items` (JSONB array of `{name, variant, qty, price}`)
- **`products`** — menu items. `variant_type` is `none`, `options`, or `glazed`. `variants` is a JSONB array of `{label, price}`. `active` filters what customers see. `image_url` points to R2.
- **`deals`** — limited-time discounts. Fields: `product_id` (references `products.id`, no FK constraint), `discount_type` (`percent` or `dollar`), `discount_value`, `active`. Public `/deals` route JOINs with products and computes `sale_price` server-side; only rows where both `deals.active=true` AND `products.active=true` are returned.
- **`blocked_dates`** — dates on which pickup is unavailable. Uses `INSERT ... ON CONFLICT (date) DO UPDATE` so re-posting the same date updates the reason.
- **`luxe_bookings`** — $40 consultation deposit bookings. Stripe webhook marks these `status='paid'` when `s.metadata.type === 'luxe_booking'`.
- **`luxe_sections`** — sections on the Luxe menu page. Use soft deletes (`archived=true`). IDs are `{slug}_{timestamp36}`, not UUIDs.
- **`luxe_items`** — items within Luxe sections. Have `section_id`, `active`, `display_order`.
- **`session`** — pg-backed express sessions (managed by `connect-pg-simple`)

Schema migrations are handled inline in `initDB()` using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. New columns should be added this way rather than with a separate migration runner.

### Key code patterns

- **`rowToProduct()` / `rowToOrder()`** — DB rows come back in snake_case; these helpers normalize to camelCase before sending to clients.
- **`updateProductById(id, patch)` / `updateOrder(id, patch)`** — Dynamic `SET` builders. Only keys present in the incoming `patch` object (matched against a `colMap` whitelist) are included in the `UPDATE`. Always use these helpers rather than writing inline UPDATE queries.
- **`initDB()`** also seeds products and Luxe items on first run if tables are empty, and runs one-time data migrations (e.g. Chapman Drink variant fix).
- **R2 uploads** use `multer({ storage: memoryStorage() })` — no temp files. Key format: `products/{uuid}{ext}`. Deleting a product does NOT clean up its R2 image.

### `pickupDate` format

Always store and compare as ISO `YYYY-MM-DD`. The checkout route normalizes via `new Date(pickupDate).toISOString().slice(0,10)` before blocked-date lookup. The admin uses `parsePickupISO()` in `admin.html` to normalize legacy `"March 21, 2026"` format dates from older orders.

### Weekend summary logic (admin.html)

The admin dashboard shows a weekend summary filtered by `pickupDate` ISO match against the computed `satISO`/`sunISO` for the current weekend window:
- Saturday → shows Sat + Sun of current week
- Sunday → shows yesterday (Sat) + today (Sun)
- Mon–Fri → shows coming Sat + Sun

Item quantity summary and customer list are visible **during** the day and disappear after the day ends (`dayEnded = isoDate < todayISO`).

### Luxe flows (two separate paths)

- **`/luxe-inquiry`** (`POST`) — email-only inquiry, no DB record, no payment. Sends admin notification via Resend and returns `{ ok: true }`.
- **`/luxe-booking`** / **`/create-luxe-booking`** — $40 deposit flow with a `luxe_bookings` DB record and Stripe checkout session. Webhook sets `status='paid'` when `s.metadata.type === 'luxe_booking'`.

### Image storage

Product images are uploaded to Cloudflare R2 (S3-compatible) via `POST /admin/upload-image`. The public URL is stored in `products.image_url`. Luxe event photography lives in `public/luxe-images/` and is served statically — those are not R2 images.

### Test mock setup (`tests/setup.js`)

All external dependencies are `jest.mock()`'d:
- **`pg`**: Single shared `mQuery` jest.fn. Grab it via `Pool.mock.results[0].value.query`. Chain `mockResolvedValueOnce()` calls in order to simulate multi-query routes.
- **`uuid`**: Replaced by `tests/__mocks__/uuid.js` with a deterministic counter (`test-uuid-1`, `test-uuid-2`, ...). UUID v13 is ESM-only and incompatible with Jest's CJS transform.
- **`stripe`**, **`resend`**, **`@aws-sdk/client-s3`**: All no-op mocks. `stripe.webhooks.constructEvent` is mocked to return test payloads.

Jest config has `resetMocks: false` — mocks are not auto-reset between tests. Use `mockQuery.mockReset()` manually when a test needs different DB responses than a `beforeEach` set up.

### Deployment

Hosted on Render. Pushing to `main` on GitHub triggers an automatic redeploy.
