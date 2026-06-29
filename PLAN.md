# Super Astrology & Wellness Platform — Backend Build Plan

## Context

Greenfield Node.js backend in an **empty** dir (`/Users/subhojitdutta/Desktop/d/rg-phase-2`). It powers an astrology/wellness app: WhatsApp-OTP login, a prepaid wallet, per-minute audio/video consultations with astrologers (Agora), real-time chat & call signaling (Socket.io), an AI astrologer (OpenAI), Vedic kundli/matchmaking (VedicAstroAPI), a products store, gifting, matrimony, pooja bookings, and automated astrologer payouts (PayU).

Decisions locked with the user:
- **OTP transport** = self-hosted **WABridge HTTP bridge** (replicate productivo-backend's exact `createtextmessage` contract), not a paid BSP.
- **Payments** = **PayU** Checkout (collections) + PayU Payout (settlements).
- **Queue** = **simple Mongo-backed in-process** queue with retry/backoff (no BullMQ/Redis).
- **Vedic** = **VedicAstroAPI** (vedicastroapi.com), wrapped + cached, with local Ashtakoot fallback.
- **Extras to include**: hardened wallet ledger, rate-limiting + audit log, Swagger + seed script, Agora call recording + reviews.
- **Module system** = **CommonJS** throughout (matches flatemate-server). **Money** = integer **paise** everywhere (no floats in the ledger).

Conventions mirrored from the user's existing `flatemate-server`: `AppError`, `asyncHandler`, `validate(joiSchema)`, `protect`/`requireRole`, `errorHandler`, thin controllers + service layer, `app.set('io', io)`, `Map<userId, Set<socketId>>` socket registry, swagger-jsdoc, seed script.

> **Infra note (load-bearing):** wallet multi-doc transactions need a **replica set** (Atlas = yes). Provide a `MONGO_TX_ENABLED` flag so local standalone Mongo falls back to the transaction-free atomic-update path (overdraft guard still intact).

> **Scalability stance (locked):** the backend is designed **horizontally scalable / multi-instance from day one** — no in-memory state is authoritative. Socket fan-out goes through a **pluggable adapter** (`SOCKET_ADAPTER=redis|mongo|memory`); presence lives in a **shared store** (Redis or Mongo), not a per-process `Map`; per-minute **billing is a DB-backed recurring job** any instance can run. Redis is free (self-host at zero license cost; managed tiers optional) — it is the default adapter, with a Mongo change-streams adapter as a fully Redis-free fallback and `memory` for single-process local dev. See the **Scalability & Strong Connections** section.

---

## Folder Structure (MVC + websockets + workers)

```
/config       env.js, db.js, agora.js, firebase.js, payu.js, openai.js, swagger.js
/models       (16 schemas — see below)
/controllers  thin: parse req → service → res.json({success,data})
/routes       one router per resource, mounted in routes.js
/middlewares  auth.js (protect, verifiedOnly), role.js, validate.js, errorHandler.js, rateLimit.js, apiLogger.js
/services     auth, otp, waBridge, wallet, call, agora, recording, chat, job, payu, payout,
              vedicAstro, ai, fcm, gift, product, order, matrimony, kundliMatch, pooja, admin
/utils        AppError.js, asyncHandler.js, validators.js (Joi), token.js, money.js, hash.js
/websockets   index.js (initSocket), registry.js, emit.js, callHandlers.js, chatHandlers.js, presence.js
/workers      jobWorker.js
/scripts      seed.js
app.js, server.js, .env.example, README.md
```

---

## Models (16 Mongoose schemas)

Auth/wallet/call (per core design):
1. **User** — name, phone(unique), email(sparse), role[user/astrologer/admin], birthDetails{dob,time,place,lat,lng}, isPhoneVerified, fcmTokens[{token,platform,addedAt}], isBlocked, astrologerProfile ref.
2. **OtpRequest** — phone, codeHash(select:false), expiresAt(**TTL**), attempts, consumed, lastSentAt, sendCount. Partial-unique `{phone, consumed:false}`.
3. **RefreshToken** — user, tokenHash(sha256, unique), expiresAt(TTL), revokedAt, replacedBy (rotation + reuse-detection).
4. **AstrologerProfile** — user(unique), displayName, bio, avatar, expertise[], languages[], pricePerMinute(paise), online, currentCallStatus[available/busy/offline], rating, reviewCount, totalCalls, totalCallMinutes, totalEarnings(paise), kycStatus[pending/approved/rejected], kycDocuments{idProof,selfie}, payoutDetails{upi,accountNumber,ifsc,beneficiaryName}, reviews[{user,rating,comment,createdAt}].
5. **Wallet** — user(unique), balance(paise,min:0), lockedBalance(paise,min:0), currency. virtual `available`.
6. **Transaction** — user, type[credit/debit], source[recharge/call/gift/product/withdrawal/refund/bonus/adjustment], amount(paise,min:1), status[pending/completed/failed/reversed], description, **refId(unique = idempotency key)**, balanceAfter, relatedSession, meta.
7. **CallSession** — sessionId(unique=Agora channel), caller, receiver, type[audio/video], status[initiated/ringing/ongoing/completed/missed/rejected/failed], startTime, endTime, durationSec, pricePerMinute(snapshot), cost, lockedAmount, lastBilledMinute, recordingUrl, recording{resourceId,sid,status}, agora{callerUid,receiverUid}, endReason.
8. **ChatMessage** — sessionId, sender, receiver, message(max5000), mediaUrl/mediaType, status[sent/delivered/read], timestamp.

Commerce/content/admin (this plan adds):
9. **Category** — name(unique), slug, image, isActive. (dynamic categories, admin CRUD)
10. **Product** — name, category(ref Category) + categoryName(denormalized string), images[], description, price(paise), stock, rating(avg), reviews[{user,rating,comment,createdAt}], isActive.
11. **Order** — user, items[{product, qty, priceSnapshot(paise), nameSnapshot}], address{name,phone,line1,line2,city,state,pincode}, total(paise), status[created/paid/processing/shipped/delivered/cancelled/refunded], paymentId(PayU txnid), paymentStatus[pending/paid/failed].
12. **Gift** — name, image, tokenCost(int tokens), isActive.
13. **GiftTransaction** — sender, receiver, gift, tokensSpent, relatedSession?, timestamp.
14. **MatrimonyProfile** — user(ref), gender, dob, birthTime, birthPlace{place,lat,lng,tz}, maritalStatus, familyDetails, partnerExpectations, isActive, photos[].
15. **KundliMatch** — profile1, profile2, compatibilityScore, ashtakootDetails(8 kootas + total/36), status[pending/computed/failed], computedAt.
16. **PoojaBooking** — user, astrologer, poojaType, preferredDate, status[requested/confirmed/completed/cancelled], price(paise), paymentId, paymentStatus, specialInstructions.

Supporting:
16b. **CallWaitlist** — astrologer(ref), user(ref), position, status[waiting/notified/expired/converted], joinedAt, notifiedAt. Index `{astrologer, status, joinedAt}`. (ordered queue for busy astrologers)
16c. **Presence** — userId(unique), instanceId, socketCount, role, lastSeen(TTL). (Redis-free presence fallback when `SOCKET_ADAPTER=mongo`)
17. **WithdrawalRequest** — astrologer, amount(paise), bankAccountDetails{accountNumber,ifsc,name}, status[pending/processing/paid/failed], adminNote, processedAt, payoutRef.
18. **AdminSettings** — singleton: withdrawalThreshold(default ₹500 → 50000 paise), platformFeePercentage, astrologerShare, giftTokenToPaise, signupBonus, callMaxMinutes.
19. **Job** — type, payload, status[pending/processing/done/failed], attempts, maxAttempts, nextRunAt, lockedAt, lockedBy, lastError, result, dedupeKey(unique sparse).
20. **Notification** — user, type(enum), title, body, data, isRead, createdAt.
21. **AstroCache** — cacheKey(sha256 of normalized birth params + endpoint, unique), endpoint, payload, fetchedAt, expiresAt(TTL optional).
22. **AiConversation** + **AiMessage** — conversation{user, title, lastMessageAt}; message{conversation, role[system/user/assistant], content, tokens}.
23. **ApiLog** — audit log (method, path, user, status, ms, ip) — mirrors flatemate apiLogger.

*(≥15 satisfied; extras are the hardening the user asked for.)*

---

## Subsystem Designs

### 1. Auth & OTP
- JWT **access** (15m, claims `{id,role,isPhoneVerified}`) + opaque **rotating refresh** (30d, sha256-stored, reuse→revoke family).
- `waBridgeService.sendText({to,message})`: POST `${WABRIDGE_BASE_URL}/createtextmessage` with `{'app-key','auth-key', destination_number: 91+10digit, device_id, message}`; success = truthy `data.status` (exact productivo contract). DEV bypass code `123456` when `NODE_ENV!=='production'`.
- `otpService`: requestOtp (6-digit, bcrypt, 10m TTL, per-phone cooldown 30s + 5/hr cap), verifyOtp (attempts<5, mark consumed, upsert User, mint tokens), refresh, logout, me, register/removeFcmToken.
- Routes: `POST /api/auth/request-otp` (rate-limited), `/verify-otp`, `/refresh`, `/logout`, `GET /me`, `POST|DELETE /fcm-token`.

### 2. Wallet ledger (hardened)
- **Atomic never-negative debit**: `Wallet.findOneAndUpdate({user, balance:{$gte:amount}}, {$inc:{balance:-amount}})` — returns null = insufficient. Replaces flatemate's racy read-modify-write.
- **Idempotency**: unique `refId` on Transaction; `debit/credit` short-circuit if refId exists. Per-minute call tick refId = `${sessionId}:min:${n}`; PayU credit refId = `txnid`.
- **Multi-doc consistency**: wrap wallet `$inc` + Transaction.create in a Mongoose session/transaction when `MONGO_TX_ENABLED`; else sequential with refId guard.
- **lockedBalance**: `lock` (reserve, guard available≥amount), `settleLocked` (`$inc balance -amt, lockedBalance -amt`), `releaseLock`. Used for in-call reservation + pending withdrawals.
- Routes (protect): `GET /api/wallet/balance`, `/transactions`, `POST /recharge/initiate`, public `POST /recharge/callback`.

### 3. Calls + Agora
- `agoraService.buildRtcToken` via **`agora-token`** RtcTokenBuilder; channelName=sessionId, dynamic uint32 UIDs stored on session, PUBLISHER, TTL 3600s; `GET /:sessionId/token` renews.
- Lifecycle: initiate (check astrologer available atomically, snapshot pricePerMinute, lock `min(available, rate*MAX_MIN)`, emit `incoming-call`, 30s ring timeout→missed) → accept (atomic ringing→ongoing, startTime, status busy, start recording best-effort, **enqueue first `bill_tick` job nextRunAt+60s**) → **DB-backed per-minute billing** (any instance claims the `bill_tick` job, calls `settleLocked` with deterministic refId `${sessionId}:min:${n}`, then re-enqueues the next tick; bill-at-start-of-minute; low-lock→auto-end `low_balance`) → end (cancel pending tick, releaseLock unused, **credit astrologer** `cost*astrologerShare` refId `${sessionId}:payout`, enqueue recording stop, reset status, emit `call-ended`+`wallet-updated` via adapter).
- **Why DB-backed billing (not setInterval):** an in-process timer is pinned to the accepting instance; if that instance dies, billing silently stops and the call is unbilled. A recurring `bill_tick` job in the Mongo queue can be processed by **any** instance and survives restarts. Idempotent per-minute refId means a duplicate/retried tick never double-charges. This is the core fix for multi-instance scale.
- **Recording**: Agora Cloud Recording acquire→start→stop via REST (Basic auth Customer ID/Secret), stop pushed through job queue, recordingUrl persisted.
- **Orphan sweeper** (job): force-end `ongoing` sessions whose `bill_tick` stalled (no settled minute past expected) — closes calls stranded by a crash on any instance.
- Routes (protect): `POST /api/calls/initiate`, `/:id/accept`, `/:id/reject`, `/:id/end`, `GET /:id/token`, `GET /history`. Also driven over sockets — both paths call the same `callService`.

### 4. Socket.io layer (multi-instance)
- JWT handshake auth (flatemate pattern). Personal room `user:${id}` (multi-device), call room `call:${sessionId}`, `admin-room`. **Emit by room, never by raw socket id** — so the adapter routes cross-instance.
- **Pluggable adapter** (`config/socketAdapter.js`, env `SOCKET_ADAPTER`): `redis` (`@socket.io/redis-adapter` + `redis` client, default) | `mongo` (`@socket.io/mongo-adapter` change streams, Redis-free) | `memory` (local dev). `io.adapter(...)` chosen at boot. This is what makes `io.to('user:B')` reach B even when B is connected to a different instance.
- **Shared presence store** (`presenceService`, not a per-process Map): Redis `SET online:user:{id}` with socketId members + TTL heartbeat, OR a Mongo `Presence` collection `{userId, instanceId, socketCount, lastSeen}` when Redis-free. `isOnline(userId)` / `socketIdsOf` read the shared store, so any instance has the true global picture. Per-process we keep only a thin local `Set` for fast disconnect cleanup.
- `emit.js` facade (`emitToUser`/`emitToCall`) so services emit without importing io.
- Events: `join-room`, `call-user`, `accept-call`, `reject-call`, `end-call`, `incoming-call`, `user-in-waiting`+`waiting-caller` (busy astrologer auto-notification), `send-message`/`receive-message` (persist ChatMessage; offline→FCM), `typing`, `mark-read`, `wallet-updated`, `new-notification`, presence on connect/disconnect.
- Presence sync: shared store = source of truth; `currentCallStatus` owned only by callService; disconnect mid-call → `end(...,'astrologer_offline')`; presence sweeper job reconciles ghost-online entries (instance crash → stale `lastSeen`).

### 5. Job queue (Mongo, multi-instance safe)
- `jobService`: enqueue (dedupeKey idempotent), claimNext (**atomic `findOneAndUpdate` claim — safe across N instances**, no two workers grab the same job), complete, fail (exp backoff+jitter, maxAttempts→failed), recoverStale, `scheduleRecurring`/cancel (for `bill_tick`).
- `jobWorker`: runs on **every** instance; `setInterval` poll (~2s) + stale-recovery sweep (~60s), `isPolling` re-entrancy guard, per-instance `lockedBy=${host}:${pid}`. Handlers: `bill_tick`, `payu_payout`, `fcm_send`, `agora_recording_stop`, `call_sweeper`, `presence_sweeper`, `waitlist_notify`.
- Because the claim is atomic, adding instances simply adds throughput — no coordination needed.

### 6. PayU Checkout (collections — recharge & orders)
- `payuService.buildPaymentRequest({txnid,amount,productinfo,firstname,email,udf})`: hash = `sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)`; returns form fields + action URL; create `pending` Transaction (refId=txnid) for recharge, or set Order.paymentId for orders.
- `payuService.verifyCallback(body)`: **reverse hash** `sha512(salt|status|||||udf5..1|email|firstname|productinfo|amount|txnid|key)` must equal `body.hash`; verify `amount` matches stored; only then credit wallet (idempotent refId) / mark Order paid + decrement stock.
- Routes: `POST /api/payments/payu/initiate` (protect), public `POST /api/payments/payu/callback` (surl/furl/webhook). Edge cases: replay (refId idempotency), amount tampering (server-side amount check), status spoofing (hash verify), double-credit (unique refId).

### 7. PayU Payout (settlements)
- `WithdrawalRequest` + `AdminSettings.withdrawalThreshold`. Flow: astrologer `POST /api/withdrawals` (amount ≥ threshold, ≤ available earnings; `walletService.lock`) → admin `PATCH /api/admin/withdrawals/:id/approve` → enqueue `payu_payout` job (dedupeKey=withdrawalId) → `payoutService.runPayout` calls PayU Payout API → success: `settleLocked`, status `paid`, FCM; failure: retry w/ backoff, after maxAttempts status `failed` + `releaseLock` + notify admin/astrologer.
- Double-payout prevented by dedupeKey + status guard inside handler.

### 8. OpenAI AI astrologer
- `aiService.chat({userId, conversationId, message})`: load/derive birth context (ascendant + moon sign from `vedicAstroService`, cached), inject into **system prompt**; persist `AiConversation`/`AiMessage`; **non-streaming** REST first (simpler), structured system prompt; token guardrails (max history turns, max_tokens cap). Model: latest Claude? — no, spec says OpenAI; use `openai` SDK, `gpt-4o`-class. Routes: `POST /api/ai/chat`, `GET /api/ai/conversations`, `GET /api/ai/conversations/:id`.

### 9. Vedic Astro service + cache + KundliMatch
- `vedicAstroService` wraps VedicAstroAPI GET endpoints (api_key, dob, tob, lat, lon, tz): `getChart` (ascendant+moon), `getKundli`, `getLalKitab`, `matchAshtakoot`.
- **Cache**: `AstroCache` keyed by `sha256(endpoint + normalized birth params)`; check cache→serve; on miss fetch+store; API-down → serve stale. **Local Ashtakoot fallback** util (36-guna) if provider unavailable.
- `kundliMatchService.match(profile1, profile2)` → calls matchAshtakoot (or local), persists `KundliMatch`.

### 10. CRUD domains
- **Category** (admin CRUD): `GET /api/categories`, admin `POST|PUT|DELETE /api/categories/:id`.
- **Product**: public `GET /api/products`, `GET /:id`; admin `POST|PUT|DELETE`; `POST /:id/reviews` (protect) recomputes avg rating.
- **Order**: `POST /api/orders` (snapshot price, total, PayU initiate), `GET /api/orders` (mine), `GET /:id`, admin `PATCH /:id/status` (lifecycle + FCM); stock decrement on paid (atomic, guard stock≥qty); cancel→restock+refund.
- **Gift**: `GET /api/gifts`; `POST /api/gifts/send` {giftId, receiverId} — debit sender wallet (tokens→paise via AdminSettings rate), credit receiver/astrologer, write GiftTransaction, emit `wallet-updated`+`new-notification`. Admin gift CRUD.
- **MatrimonyProfile**: CRUD (`POST|GET|PUT|DELETE /api/matrimony/profiles`), `GET /api/matrimony/search` (filters), `POST /api/matrimony/match` {profile1,profile2} → kundliMatchService.
- **PoojaBooking**: `POST /api/poojas/bookings` (PayU payment), `GET` mine, astrologer/admin `PATCH /:id/status` (requested→confirmed→completed/cancelled + FCM).

### 10b. Astrologer queue / waitlist
- When `call-user`/`POST /api/calls/initiate` targets a `busy` astrologer: instead of rejecting, `waitlistService.join(astrologerId, userId)` creates an ordered `CallWaitlist` entry, emits `user-in-waiting` (with position+ETA) to the caller and `waiting-caller` to the astrologer.
- When that astrologer's call ends (status→available) or they come online: `waitlistService.notifyNext` pops the head, emits `your-turn` socket event + FCM `astrologer_available`, sets a short claim window (e.g. 60s) via a `waitlist_notify` job; on timeout → `expired`, notify next.
- Routes: `POST /api/astrologers/:id/waitlist` (join), `DELETE /api/astrologers/:id/waitlist` (leave), `GET /api/astrologers/:id/waitlist/position`. Ordering authoritative in Mongo (`joinedAt`), safe across instances.

### 11. FCM + Notification
- `fcmService.sendNotification(userId, {type,title,body,data})`: persist `Notification`, emit `new-notification` socket, enqueue `fcm_send` job → `sendEachForMulticast` → prune dead tokens (`registration-token-not-registered`).
- Notification types: `missed_call`, `astrologer_available`, `order_status`, `withdrawal_status`, `pooja_status`, `gift_received`, `system`.
- Routes: `GET /api/notifications`, `PATCH /:id/read`, `PATCH /read-all`.

---

## Scalability & Strong Connections (multi-instance)

The design assumes **N stateless API+socket instances behind a load balancer** sharing one Mongo (replica set) and one optional Redis. Nothing authoritative lives in process memory.

**1. Horizontal socket fan-out.** Pluggable `SOCKET_ADAPTER` (redis/mongo/memory). With Redis adapter, an event emitted on instance-1 reaches a socket on instance-3. LB must use **sticky sessions** (ip-hash or cookie) so a client's polling→websocket upgrade and reconnects land on the same node; the adapter handles cross-node delivery regardless.

**2. Shared presence.** `presenceService` reads/writes Redis (or Mongo `Presence`) so "is astrologer X online" is globally correct. Heartbeat refreshes TTL every ~15s; missing heartbeat → presence sweeper marks offline and, if mid-call, force-ends.

**3. Reliable billing under scale.** `bill_tick` recurring jobs (not in-memory timers) → any instance bills, survives crashes, idempotent per-minute refId. Orphan sweeper closes stranded calls.

**4. Concurrency correctness (the "multiple users at once" guarantee).** Every contended write is a single atomic DB op, never read-modify-write:
- Wallet debit/lock/settle → conditional `findOneAndUpdate` (`$inc` guarded) → no overdraft, no lost update under parallel calls/gifts/purchases.
- Astrologer accept → atomic `ringing→ongoing` / `available→busy` transition → only one caller wins a simultaneous race.
- Order stock decrement → guarded `{stock:{$gte:qty}}` `$inc -qty` → no overselling.
- Job claim → atomic `findOneAndUpdate` → no double-processing across instances.
- Idempotency keys (`refId`, `dedupeKey`, HTTP `Idempotency-Key`) make payment/order/withdrawal retries safe.

**5. Strong connections / connection hardening.**
- Socket.io built-in reconnection + **Connection State Recovery** (replays missed events on brief drops); client resumes with last offset.
- Heartbeat tuning: `pingInterval`/`pingTimeout` set explicitly; per-user socket cap (e.g. 5 devices) to prevent socket exhaustion.
- **JWT over socket**: handshake auth + a `refresh-token` socket event so a long-lived socket re-auths without dropping the call; expired token mid-session → grace re-auth, then disconnect.
- Backpressure: cap inbound message rate per socket; reject oversized payloads (chat ≤5000 chars).
- Disconnect ≠ immediate offline: short grace (e.g. 10s) before flipping presence/ending calls, so a flaky network blip doesn't kill an active consultation.

**6. Graceful shutdown + health.** On `SIGTERM`: stop accepting new connections/jobs, finish in-flight `bill_tick`/jobs, emit `server-draining` so clients reconnect elsewhere, close sockets, drain Mongo/Redis, exit. Endpoints: `GET /healthz` (liveness), `GET /readyz` (Mongo+Redis+worker ready) for LB/k8s probes — enables zero-downtime rolling deploys even with live calls.

**7. Observability.** Request-id correlation (`X-Request-Id`) threaded across HTTP → socket → jobs; structured JSON logs (pino-style) with instanceId; `ApiLog` audit collection. Makes debugging concurrent multi-instance flows tractable.

**8. Rate limiting at scale.** `express-rate-limit` with a **shared store** (Redis store when available) so limits are global, not per-instance — otherwise N instances = N× the intended limit.

**Scaling boundaries called out:** sticky sessions required at LB; Redis recommended for >2 instances (Mongo adapter works but higher latency); Agora/PayU/OpenAI/Vedic rate limits are external ceilings handled via the retrying job queue + cache.

---

## Dependencies (exact)
Proven in flatemate: `express@^5.2.1`, `mongoose@^9.3.1`, `socket.io@^4.8.3`, `jsonwebtoken@^9.0.3`, `bcryptjs@^3`, `joi@^18`, `express-rate-limit@^8`, `helmet@^8`, `cors@^2.8.6`, `morgan@^1.10`, `dotenv@^17`, `multer@^2`, `swagger-jsdoc@^6`, `swagger-ui-express@^5`. Dev: `nodemon`, `jest`, `supertest`.
New: `agora-token@^2`, `firebase-admin@^13`, `openai@^4`, `axios@^1.7`, `@socket.io/redis-adapter@^8` + `redis@^4` (default adapter), `@socket.io/mongo-adapter@^0.3` (Redis-free fallback), `rate-limit-redis@^4` (shared rate-limit store), `pino@^9` + `pino-http` (structured logs). Use Node built-in `crypto`. Redis is **optional** (free to self-host); `SOCKET_ADAPTER=mongo|memory` runs fully without it. **No BullMQ.**

`.env.example` keys: JWT/TTLs, `WABRIDGE_*`, `AGORA_APP_ID/APP_CERTIFICATE/CUSTOMER_ID/CUSTOMER_SECRET` + recording storage, `FIREBASE_SERVICE_ACCOUNT_JSON`, `OPENAI_API_KEY`, `PAYU_KEY/PAYU_SALT/PAYU_BASE_URL` + `PAYU_PAYOUT_*`, `VEDIC_ASTRO_API_KEY/BASE_URL`, `MONGO_URI`, `MONGO_TX_ENABLED`, `SOCKET_ADAPTER`, `REDIS_URL`, `INSTANCE_ID`, `MAX_CALL_MINUTES`, `RING_TIMEOUT_SEC`, `JOB_POLL_INTERVAL_MS`, `WITHDRAWAL_THRESHOLD`, `PLATFORM_FEE_PERCENT`, `SOCKET_PING_INTERVAL/TIMEOUT`, `MAX_SOCKETS_PER_USER`.

---

## Build Sequence
1. **Scaffold**: package.json, env, db, AppError/asyncHandler/validate/errorHandler/protect/requireRole, money.js, hash.js, app.js, server.js, swagger shell, apiLogger.
2. **Auth & OTP** (User, OtpRequest, RefreshToken, waBridge, otp, token, routes).
3. **Wallet** (Wallet, Transaction, walletService atomic).
4. **Sockets** (registry, initSocket, emit, presence, chat).
5. **Job queue** (Job, jobService, jobWorker, fcmService + Notification).
6. **Calls + Agora** (AstrologerProfile, CallSession, agora, recording, callService, billing, call socket handlers, reviews).
7. **PayU Checkout** (payuService, recharge + callback) → wire into wallet.
8. **PayU Payout** (WithdrawalRequest, AdminSettings, payoutService, payout job).
9. **Vedic + KundliMatch** (vedicAstroService, AstroCache, KundliMatch, local Ashtakoot).
10. **AI astrologer** (aiService, AiConversation/AiMessage).
11. **CRUD domains** (Category, Product, Order, Gift/GiftTransaction, Matrimony, Pooja).
12. **Seed script** (admin user, AdminSettings, sample gifts/categories/products/astrologer) + swagger paths + README.

---

## Verification
- `npm install` → no peer/engine errors on Node 20.
- `npm run dev` boots: Mongo connects, socket server up, job worker polling logged, no crash.
- **Auth**: `POST /request-otp` (dev returns `123456`) → `POST /verify-otp` returns access+refresh+user; `GET /me` with token works; `/refresh` rotates.
- **Wallet**: simulate PayU callback with valid reverse-hash → balance credited once; replay same txnid → no double credit; debit below balance → 402, never negative. Concurrency test: parallel debits don't overdraw.
- **Call**: two socket clients (user+astrologer JWT) → `call-user`→`incoming-call`→`accept-call`→token issued; billing tick debits wallet + emits `wallet-updated`; low balance auto-ends; `end-call` credits astrologer share.
- **Chat**: `send-message` persists + delivers `receive-message`; offline recipient → Notification + queued FCM.
- **Payout**: withdrawal ≥ threshold → admin approve → `payu_payout` job runs (mock/sandbox) → status paid + FCM; forced API failure → retries then `failed` + lock released.
- **Vedic/AI**: identical birth details hit `AstroCache` (second call no external fetch); `POST /api/ai/chat` returns astrologer reply with sign context.
- **CRUD**: Category/Product/Order/Gift/Matrimony(+match)/Pooja happy-path + auth gating (admin-only routes reject non-admin).
- Swagger UI loads at `/api-docs`; `npm run seed` populates admin + samples.
- `npm test` (jest+supertest) on auth + wallet-idempotency at minimum.

> If sandbox keys for PayU/Agora/VedicAstroAPI/Firebase/OpenAI are absent, those services run in an env-gated **mock mode** (logged, deterministic responses) so the full app boots and flows are testable without live credentials.
