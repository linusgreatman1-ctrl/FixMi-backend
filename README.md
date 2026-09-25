# FixMi Backend

Backend API for **FixMe — trusted artisans on demand** (electricians,
plumbers, carpenters, AC techs, and more — matched nearby, tracked live,
paid via escrow). Built against the frontend prototype uploaded as
`FixMe_App.html` (a single-file HTML/CSS/JS mockup whose entire app state
lived in in-memory JS objects with `toast('...')` stand-ins for every real
action).

Node/Express + Prisma/PostgreSQL + JWT + Socket.IO + Paystack, following
the same conventions as `handa-backend` (this account's other product).

## What this replaces

Every button in the frontend that used to end in `toast('...')` now has a
matching endpoint here: real accounts, a real Postgres database, real
escrow-held payments, and Socket.IO push for the "finding an artisan"
radar screen, live job status, and chat — instead of client-side
`setTimeout` simulations that stopped the moment a tab closed.

## Deploying (go live)

This repo includes a `render.yaml` Blueprint that provisions both the web
service and a free Postgres database in one go:

1. Push this repo to GitHub (already done if you're reading this on
   GitHub).
2. On [Render](https://dashboard.render.com), click **New → Blueprint**
   and connect the `fixmi-backend` repo. Render reads `render.yaml` and
   sets up the web service + database + JWT secrets automatically.
3. Before the first deploy finishes, add your Paystack keys (the
   Blueprint leaves `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` blank on
   purpose) — test keys from
   [dashboard.paystack.com](https://dashboard.paystack.com/#/settings/developers)
   are fine to start with.
4. Once deployed, open the **Shell** tab on the web service and run
   `npm run seed` once to load demo data.
5. Your live app is at `https://<your-service-name>.onrender.com/app`.

Render's free tier sleeps the web service after ~15 min idle (next
request takes ~30-50s to wake it) and the free Postgres database expires
30 days after creation — upgrade it from the Render dashboard before then
to keep your data. See `handa-backend`'s README for more on these
free-tier specifics, since this follows the same setup.

Prefer a different host (Railway, Fly.io, etc.)? `render.yaml` is
Render-specific, but the app itself is a standard Node/Express app with a
Postgres dependency — the manual setup below works anywhere.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT secrets, PAYSTACK keys
npm run prisma:migrate # creates the database schema
npm run seed            # demo admin + 5 verified artisans + 1 pending + 1 customer
npm run dev
```

Server listens on `PORT` (default 4000). `GET /health` for a liveness
check. Demo logins (see `prisma/seed.js`), all using password
`password123`:

- Admin: `linusgreatman1@gmail.com`
- Customer: `ada@example.com`
- Artisans: `emeka@example.com` (Electrician), `taiwo@example.com`
  (Plumber), `ibrahim@example.com` (AC Tech), `yusuf@example.com`
  (Carpenter), `chidinma@example.com` (Cleaner) — all pre-verified.
- Pending artisan awaiting approval: `musa@example.com` (Welder).

### Required env vars (see `.env.example`)

- `DATABASE_URL` — Postgres connection string
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — long random strings
- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` — from the Paystack
  dashboard (test keys are fine for dev)
- `CORS_ORIGINS` — comma-separated list of frontend origins allowed to
  send cookies
- `DEV_BYPASS_PAYMENTS=true` — lets every wallet debit succeed regardless
  of balance, and unlocks `POST /api/payments/wallet-deposit/dev` (credits
  a wallet directly, no real Paystack charge), so the whole booking
  lifecycle can be clicked through without needing real funds. **Turn this
  off before treating this as a real product.**

Register a webhook in the Paystack dashboard pointing at
`https://<your-domain>/api/payments/webhook` for `charge.success`,
`transfer.success`, and `transfer.failed` — this is what finalizes wallet
top-ups and withdrawals even if the customer closes the tab before the
frontend's own verify-poll runs.

## Data model

See `prisma/schema.prisma`. Three roles (`CUSTOMER`, `ARTISAN`, `ADMIN`).
An `ARTISAN` account carries an `ArtisanProfile` with a free-text
`category` (Electrician, Plumber, AC Tech, ... — open-ended, not a fixed
enum, since the frontend's service grid can grow without a migration) and
a `kycStatus` an admin must move to `APPROVED` before the artisan can go
online. Money is stored as `Int` kobo throughout (Paystack's own unit),
never float.

Every paid booking is split into two `EscrowHold` rows at payment time —
one for the artisan (the price minus platform commission), one for the
platform's commission cut — released together when the customer confirms
the job (`src/services/escrow.service.js`). A background sweep
(`realtime/live.js`, every 5 min) auto-releases holds whose
`autoReleaseAt` window has passed and closes out the booking even if the
customer never taps Confirm.

## Booking lifecycle

```
REQUESTED --accept--> ACCEPTED --pay--> PAID --start--> IN_PROGRESS
   |                     |                                  |
   +--cancel (no refund needed)      cancel (refund)---------+
                                                              |
                                                          complete
                                                              v
                                                          COMPLETED --confirm--> CONFIRMED
                                                       (auto-releases after
                                                        ESCROW_AUTO_RELEASE_HOURS
                                                        if never confirmed)
```

A booking is created `REQUESTED` with no artisan assigned and broadcast
(Socket.IO `booking:new` + a push `Notification`) to every available,
verified artisan in that category — first to `POST /bookings/:id/accept`
wins, matching the frontend's "finding artisan" radar screen. Accepting
also opens a `ChatThread` between customer and artisan.

## API surface

All routes are under `/api`. Auth is a Bearer access token (15min) +
httpOnly refresh cookie (30d, rotated on use) — same dual-delivery pattern
as `handa-backend` (the refresh token is also returned in the JSON body so
multiple tabs/devices can hold independent sessions).

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `/login`, `/guest`, `/refresh`, `/logout`, `GET /auth/me` |
| Users | `PATCH /users/me`, `/me/artisan-profile`, `/me/availability` (go online/offline), `POST /me/avatar`, `/me/bank-account`, `GET /users/banks` |
| Artisans | `GET /artisans` (filter by `category`, `onlyAvailable`, sorted by distance if `lat`/`lng` given), `GET /artisans/:id`, `GET /artisans/categories` |
| Search | `GET /search?q=` |
| Bookings | `POST /bookings`, `GET /bookings` (mine), `GET /bookings/open` (artisan's open job feed), accept/decline/pay/start/complete/confirm/cancel |
| Wallet | `GET /wallet`, `/wallet/transactions`, `POST /wallet/withdraw`, `GET /wallet/withdrawals` |
| Payments | `POST /payments/wallet-deposit` (Paystack), `/payments/wallet-deposit/dev` (DEV_BYPASS only), `GET /payments/verify/:reference`, `POST /payments/webhook` |
| Ratings | `POST /ratings` (one row per side per booking — customer rates artisan and vice versa) |
| Support | `POST /support/tickets`, `GET /support/tickets` (mine) |
| Notifications | `GET /notifications`, `PATCH /:id/read`, `PATCH /read-all` |
| Chat | `GET /chat/threads`, `GET/POST /chat/threads/:id/messages` |
| Admin | `GET /admin/stats`, `/artisans/pending` + approve/reject, `/users` + suspend/reactivate, `/bookings`, `/tickets` |

## Real-time (Socket.IO)

Connect with `auth: { token: accessToken }`. Rooms: `user:{id}` (personal
— notifications, new-job broadcast to artisans), `booking:{id}`,
`chat:{threadId}`. `artisan:location` events update the artisan's live
position and rebroadcast to whichever booking room they're actively
working — this is what should replace the frontend's animated
tracking-map placeholder. WebRTC `call:offer/answer/ice-candidate` are
relayed for the in-app customer↔artisan call button (video/audio itself is
peer-to-peer, never through this server).

## Mobile & desktop

- `mobile/` — Capacitor project wrapping `public/app` for installable
  Android/iOS builds.
- `desktop/` — Electron wrapper for installable Windows/Mac/Linux builds.

Both load the same static frontend this backend serves at `/app`; point
their config at a deployed API URL before building for distribution.

## Known simplifications

- No SMS OTP — the frontend's OTP screen is decorative; auth is
  email/phone + password (same as `handa-backend`, which never wired real
  OTP into login either).
- Withdrawals are created `PENDING` and expected to be paid out by an
  admin/cron calling Paystack's Transfer API (`src/services/
  paystack.service.js` already has `createTransferRecipient` /
  `initiateTransfer`) — not automated yet.
- No manual bank-transfer top-up path (handa-backend's
  `manualPayments.service.js` equivalent) — only card/Paystack checkout
  and the dev-bypass credit.
- Negotiation/counter-offer, feature-boost promotion, portfolio image
  uploads, and canned quick-replies are still frontend-only UI in
  `FixMe_App.html` — not backed by new endpoints in this first pass.
- Cancellation refunds land as wallet credit rather than reversing the
  original Paystack charge — simpler, matches how most Nigerian
  marketplace apps handle this.
