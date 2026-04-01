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

Tests use Jest + Supertest against a fully mocked environment (no real DB/Stripe/Resend needed). The mock setup is in `tests/setup.js`.

## Environment Variables

Required in `.env` (never committed):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase/PostgreSQL connection string |
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

Single-file Express backend (`server.js`) serving static HTML/CSS/JS frontends from `public/`. No frontend build step.

### Data flow
1. Customer browses `public/index.html` → fetches `/products` → adds to cart → fills checkout form → `POST /create-checkout-session` → redirected to Stripe hosted checkout
2. On payment, Stripe fires a webhook → `POST /stripe-webhook` → order status set to `'paid'` → confirmation email sent via Resend
3. Admin at `/admin` (protected by session) views `public/admin.html` → fetches `/admin/orders` → manages orders, products, blocked dates

### Database tables
- **`orders`** — customer orders. Key fields: `status` (`pending_payment`/`paid`/`cancelled`/`completed`), `pickup_status` (`pending`/`ready`/`picked_up`), `pickup_date` (ISO `YYYY-MM-DD`), `pickup_day` (legacy `Saturday`/`Sunday`), `items` (JSONB array of `{name, variant, qty, price}`)
- **`products`** — menu items. `variant_type` is `none`, `options`, or `glazed`. `variants` is a JSONB array of `{label, price}`.
- **`blocked_dates`** — dates on which pickup is unavailable
- **`session`** — pg-backed express sessions

### `pickupDate` format
Always store and compare as ISO `YYYY-MM-DD`. The admin uses `parsePickupISO()` in `admin.html` to normalize legacy `"March 21, 2026"` format dates from older orders.

### Weekend summary logic (admin.html)
The admin dashboard shows a weekend summary filtered by `pickupDate` ISO match against the computed `satISO`/`sunISO` for the current weekend window:
- Saturday → shows Sat + Sun of current week
- Sunday → shows yesterday (Sat) + today (Sun)
- Mon–Fri → shows coming Sat + Sun

Item quantity summary and customer list are visible **during** the day and disappear after the day ends (`dayEnded = isoDate < todayISO`).

### Image storage
Product images are uploaded to Cloudflare R2 (S3-compatible) via `POST /admin/upload-image`. The public URL is stored in `products.image_url`.

### Deployment
Hosted on Render. Pushing to `main` on GitHub triggers an automatic redeploy.
