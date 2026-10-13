# FixMi handover

FixMi is an artisan marketplace: customers book electricians, plumbers and so on, and payment goes through escrow. It is its own app, separate from Handa.

- Repo: `linusgreatman1-ctrl/FixMi-backend`, branch `main`. Everything is merged, up to PR #5.
- Live: https://fixmi-backend-production.up.railway.app/app (admin page at `/admin`).
- Hosting: Railway auto-deploys from `main`. The start command runs `prisma migrate deploy`.

## Stack and layout

- Server: Node/Express, Prisma with PostgreSQL, Socket.IO for live updates.
- App: one file, `public/app/index.html`.
- Server code: `src/controllers`, `src/routes`, `src/services` (escrow, wallet, corporate) and `src/realtime/live.js` (sockets, call relay, escrow release check).
- Mobile and desktop wrappers in `mobile/` and `desktop/` load the live URL.

## How things work now

- **Booking:** the customer's budget goes into escrow from their wallet. Artisans accept the price, counter, or ask for "Price on Hold". The escrow is topped up or refunded to match the agreed price.
- **Fee and release:** FixMi takes 10% (`PLATFORM_COMMISSION_PERCENT`). Escrow auto-releases 5 minutes after the job is marked done (`ESCROW_AUTO_RELEASE_MINUTES`).
- **"Job not completed":** freezes the money. The artisan adds their side, then an admin at `/admin` pays the artisan, refunds the customer, or splits it.
- **Calls:** in-app voice call copied from the Handa app (WebRTC). The chat screen also has a call button.
- **Corporate plans:** funded from the wallet; their jobs draw their budget from the plan's escrow.
- **Live data:** home stats, profiles, reviews, bank details, withdrawals and support requests all use the database.

## Testing period

- `DEV_BYPASS_PAYMENTS=true` and `AUTO_APPROVE_ARTISANS=true`.
- No Paystack key yet, so artisans type their bank account name themselves.
- Test accounts: Ada (customer, +2348010000001) and Emeka (artisan, +2348010000002). They keep sample activity on purpose. Every other account shows only real data.

## Still open

- Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` on Railway to use `/admin`.
- Add a Paystack key for real payments, bank-name lookup and withdrawal payouts. Withdrawals stay "Pending" for now.
- Optionally add a TURN server (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) so calls connect on strict mobile networks.
- Old prototype screens remain in `index.html`; only Ada's and Emeka's sample cards link to them.
