# Rudraganga — Astrology & Wellness Platform — Backend

Node.js (Express) + MongoDB (Mongoose) + Socket.io backend for an astrology &
wellness app: WhatsApp-OTP auth, prepaid wallet, per-minute **call / chat /
video** consultations, gifting, store, matrimony + kundli matching, pooja
bookings, AI astrologer, and PayU payments & automated payouts.

> Every third-party integration (WhatsApp, Agora, FCM, OpenAI, PayU, VedicAstroAPI)
> has a **MOCK mode** — leave its keys blank and the app still boots and the full
> flow is testable locally. Fill keys in `.env` to go live.

## Quick start

```bash
cd backend
cp .env.example .env          # edit JWT_SECRET at minimum
npm install
npm run seed                  # admin + sample astrologer/products/gifts
npm run dev                   # http://localhost:5000  (docs at /api-docs)
```

Requires Node 20+ and a MongoDB instance. For wallet DB-transactions set
`MONGO_TX_ENABLED=true` and point `MONGO_URI` at a replica set (Atlas, or a
local single-node replica set). Otherwise the wallet uses the transaction-free
atomic path (overdraft guard still enforced).

## Key business rules baked in

- **Astrologers are admin-created.** Public `POST /api/astrologers/apply` is only
  a lead. Admin fills rates + commission + KYC via `PUT /api/admin/astrologers/:id`
  and sets `applicationStatus: active` — only then can they receive requests.
- **Three per-service rates**, each with an **absolute ₹/min admin commission**:
  e.g. call ₹10/min, admin cut ₹2/min → astrologer earns ₹8/min. Split is captured
  on every session (`totalAmount` / `adminEarning` / `astrologerEarning`).
- **Online toggle gates everything.** An astrologer receives call/chat/video only
  while `isOnline` + `available` + the service is enabled.
- **60-second ring window** for all three types. Missed / rejected → session is
  stored with status + **₹0 charged** (reservation released). Frequent misses
  raise an **escalation** to admins.
- **Money is whole rupees** (integer paise, multiples of 100). **Duration rounds
  UP** to the next minute: 30s → 1 min, 1m3s → 2 min.
- **Billing engine**: on accept, minute 1 is charged immediately; each further
  minute is charged at its start via a DB-backed `bill_tick` job (survives
  restarts, idempotent per-minute `refId`). Low balance auto-ends the session.

## Architecture

```
config/        env, db, swagger
models/        23 Mongoose schemas
services/      business logic (wallet, session engine, payu, payout, vedic, ai, ...)
controllers/   thin HTTP handlers
routes/        one router per resource (mounted under /api)
middlewares/   auth, role, validate, rateLimit, errorHandler, apiLogger
websockets/    socket.io init + emit facade (pluggable redis/mongo/memory adapter)
workers/       jobWorker (Mongo-backed queue: bill_tick, ring_timeout, payu_payout, fcm_send, recording)
scripts/       seed
```

## Real-time (Socket.io)

Connect with `auth: { token: <accessToken> }`. Events: `set-online`,
`start-session`, `accept-session`, `reject-session`, `join-session`,
`end-session`, `send-message` / `receive-message`, `typing`, `mark-read`,
`heartbeat`. Server emits: `incoming-request`, `request-accepted`,
`request-rejected`, `request-missed`, `session-ended`, `wallet-updated`,
`new-notification`, `gift-received`, `presence-changed`, `escalation-raised`.

## Scaling

Stateless multi-instance. Set `SOCKET_ADAPTER=redis` (or `mongo`) + a shared
store so socket fan-out works across instances; billing runs from the shared
job queue so any instance can process it. `GET /healthz` + `GET /readyz` for
load-balancer / k8s probes; `SIGTERM` drains sockets and in-flight jobs.

## Seeded test accounts (dev OTP = `123456`)

| Role       | Phone        | Notes                                   |
|------------|--------------|-----------------------------------------|
| Admin      | `9999900000` | full admin API                          |
| Seeker     | `9888800000` | ₹1000 wallet, birth details set         |
| Astrologer | `9777700000` | active; call ₹10/min (admin ₹2 / astro ₹8) |

Login: `POST /api/auth/request-otp { phone }` then
`POST /api/auth/verify-otp { phone, code: "123456" }`.
# rg-phase-2-be
