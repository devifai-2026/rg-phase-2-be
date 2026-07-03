require('dotenv').config();

/**
 * Centralized, validated environment config.
 * Every other module imports from here — never reads process.env directly.
 */
const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  instanceId: process.env.INSTANCE_ID || `${require('os').hostname()}:${process.pid}`,

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/astro_wellness',
  mongoTxEnabled: process.env.MONGO_TX_ENABLED === 'true',

  jwt: {
    secret: process.env.JWT_SECRET || 'dev_jwt_secret_change_me',
    accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10),
  },

  // WhatsApp OTP via WABridge HTTP bridge (productivo pattern)
  waBridge: {
    baseUrl: process.env.WABRIDGE_BASE_URL || 'https://web.wabridge.com/api',
    appKey: process.env.WABRIDGE_APP_KEY || '',
    authKey: process.env.WABRIDGE_AUTH_KEY || '',
    deviceId: process.env.WABRIDGE_DEVICE_ID || '',
    otpTemplateId: process.env.WABRIDGE_TEMPLATE_OTP || '',
  },

  otp: {
    length: 6,
    ttlSec: parseInt(process.env.OTP_TTL_SEC || '600', 10), // 10 min
    resendCooldownSec: parseInt(process.env.OTP_RESEND_COOLDOWN_SEC || '30', 10),
    maxSendsPerHour: parseInt(process.env.OTP_MAX_SENDS_PER_HOUR || '5', 10),
    maxVerifyAttempts: parseInt(process.env.OTP_MAX_VERIFY_ATTEMPTS || '5', 10),
    devCode: process.env.OTP_DEV_CODE || '123456',
  },

  agora: {
    appId: process.env.AGORA_APP_ID || '',
    appCertificate: process.env.AGORA_APP_CERTIFICATE || '',
    tokenTtlSec: parseInt(process.env.AGORA_TOKEN_TTL_SEC || '3600', 10),
    customerId: process.env.AGORA_CUSTOMER_ID || '',
    customerSecret: process.env.AGORA_CUSTOMER_SECRET || '',
    recordingBucket: process.env.AGORA_REC_BUCKET || '',
    recordingVendor: parseInt(process.env.AGORA_REC_VENDOR || '1', 10), // 1=AWS S3
    recordingRegion: parseInt(process.env.AGORA_REC_REGION || '0', 10),
    recordingAccessKey: process.env.AGORA_REC_ACCESS_KEY || '',
    recordingSecretKey: process.env.AGORA_REC_SECRET_KEY || '',
  },

  firebase: {
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '', // path or base64 JSON
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    maxHistoryTurns: parseInt(process.env.OPENAI_MAX_HISTORY_TURNS || '12', 10),
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '700', 10),
  },

  // Pluggable LLM layer for the AI insights features (chat recap, re-engagement,
  // profile optimizer, live moderation). `provider` picks the backend; both fall
  // back to a deterministic mock when their credentials are absent (dev-safe).
  //   - 'gemini' (default): Vertex AI, authenticated with the EXISTING GCS
  //     service-account (gcs.credentialsJson / gcs.keyFile) — no new key.
  //   - 'openai': reuses the openai client above.
  llm: {
    provider: process.env.LLM_PROVIDER || 'gemini',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // Vertex Imagen model for generated storefront hero art (decorative images).
    imageModel: process.env.IMAGEN_MODEL || 'imagen-4.0-fast-generate-001',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '1024', 10),
    // Turns of prior chat history fed back to the model (AI astrologer chat).
    maxHistoryTurns: parseInt(process.env.LLM_MAX_HISTORY_TURNS || '12', 10),
    vertex: {
      // Defaults to the GCS project; override if Gemini runs in a different one.
      projectId: process.env.VERTEX_PROJECT_ID || process.env.GCS_PROJECT_ID || '',
      location: process.env.VERTEX_LOCATION || 'us-central1',
    },
  },

  payu: {
    key: process.env.PAYU_KEY || '',
    salt: process.env.PAYU_SALT || '',
    baseUrl: process.env.PAYU_BASE_URL || 'https://test.payu.in', // sandbox default
    surl: process.env.PAYU_SURL || 'http://localhost:5000/api/payments/payu/callback',
    furl: process.env.PAYU_FURL || 'http://localhost:5000/api/payments/payu/callback',
    payout: {
      baseUrl: process.env.PAYU_PAYOUT_BASE_URL || 'https://uatoneapi.payu.in',
      clientId: process.env.PAYU_PAYOUT_CLIENT_ID || '',
      clientSecret: process.env.PAYU_PAYOUT_CLIENT_SECRET || '',
      accountId: process.env.PAYU_PAYOUT_ACCOUNT_ID || '',
    },
  },

  imagebb: {
    apiKey: process.env.IMAGEBB_API_KEY || '',
  },

  // GeoNames — free city search (place-of-birth autocomplete). Get a username at
  // geonames.org and enable web services. Falls back to Nominatim if unset.
  geonames: {
    username: process.env.GEONAMES_USERNAME || '',
  },

  // Google Cloud Storage — primary image host (falls back to ImageBB/mock if unset).
  gcs: {
    projectId: process.env.GCS_PROJECT_ID || '',
    bucket: process.env.GCS_BUCKET || '',
    // Provide ONE of: a key-file path, or the key JSON inline (handy for deploys).
    keyFile: process.env.GCS_KEY_FILE || '',
    credentialsJson: process.env.GCS_CREDENTIALS_JSON || '',
    // Folder prefix inside the bucket for uploads (keeps recordings separate).
    uploadPrefix: process.env.GCS_UPLOAD_PREFIX || 'uploads',
    // Agora Cloud Recording writes the mixed file to GCS. Agora authenticates to
    // GCS with HMAC keys (Console → Cloud Storage → Settings → Interoperability).
    // Defaults to the main bucket; override with a dedicated recordings bucket.
    recordingBucket: process.env.GCS_RECORDING_BUCKET || process.env.GCS_BUCKET || '',
    hmacKey: process.env.GCS_HMAC_KEY || '',
    hmacSecret: process.env.GCS_HMAC_SECRET || '',
  },

  vedicAstro: {
    apiKey: process.env.VEDIC_ASTRO_API_KEY || '',
    baseUrl: process.env.VEDIC_ASTRO_BASE_URL || 'https://api.vedicastroapi.com/v3-json',
    cacheTtlDays: parseInt(process.env.VEDIC_CACHE_TTL_DAYS || '365', 10),
  },

  socket: {
    adapter: process.env.SOCKET_ADAPTER || 'redis', // redis | mongo | memory (falls back to memory if unreachable)
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL || '25000', 10),
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT || '20000', 10),
    maxSocketsPerUser: parseInt(process.env.MAX_SOCKETS_PER_USER || '5', 10),
  },

  presence: {
    // An astrologer with the toggle ON is shown online only while their device
    // proved connectivity within this window (socket heartbeat OR FCM ping ACK).
    // No internet for longer → auto-offline.
    reachableTtlMs: parseInt(process.env.PRESENCE_REACHABLE_TTL_MS || '300000', 10), // 5 min
    // How often the worker silently FCM-pings toggled-on astrologers whose
    // reachability is going stale, so a killed-but-online device re-ACKs and
    // stays online. Should be comfortably < reachableTtlMs.
    probeIntervalMs: parseInt(process.env.PRESENCE_PROBE_INTERVAL_MS || '90000', 10), // 90s
    // Only ping devices whose lastReachableAt is older than this (avoid pinging
    // an astrologer whose socket heartbeat already keeps them fresh).
    probeStaleAfterMs: parseInt(process.env.PRESENCE_PROBE_STALE_AFTER_MS || '60000', 10), // 60s
  },

  notifyMe: {
    // When a seeker taps "notify me" on a busy/offline astrologer, nudge the
    // astrologer ("N people are waiting for you") — but at most once per this
    // window per astrologer, so a burst of waiting seekers can't spam them.
    astroNudgeThrottleMs: parseInt(process.env.NOTIFY_ME_ASTRO_NUDGE_THROTTLE_MS || '180000', 10), // 3 min
  },

  call: {
    maxMinutes: parseInt(process.env.MAX_CALL_MINUTES || '120', 10),
    ringTimeoutSec: parseInt(process.env.RING_TIMEOUT_SEC || '30', 10),
  },

  jobs: {
    pollIntervalMs: parseInt(process.env.JOB_POLL_INTERVAL_MS || '2000', 10),
    staleSweepMs: parseInt(process.env.JOB_STALE_SWEEP_MS || '60000', 10),
    staleMs: parseInt(process.env.JOB_STALE_MS || '120000', 10),
    defaultMaxAttempts: parseInt(process.env.JOB_MAX_ATTEMPTS || '5', 10),
    // Re-engagement (Feature 2): how often to scan for due time-bound cues.
    // Idempotent + cheap; default every 6h so due nudges fire promptly.
    reengagementScanMs: parseInt(process.env.REENGAGEMENT_SCAN_MS || String(6 * 60 * 60 * 1000), 10),
  },

  // Cache-aside layer (GCP Memorystore / any Redis). Disabled by default so the
  // server boots with zero infra — cacheService falls through to the loader.
  // Reuses socket.redisUrl when CACHE_REDIS_URL is unset (one Memorystore).
  cache: {
    enabled: process.env.CACHE_ENABLED === 'true',
    redisUrl: process.env.CACHE_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    defaultTtlSec: parseInt(process.env.CACHE_DEFAULT_TTL_SEC || '60', 10),
    keyPrefix: process.env.CACHE_KEY_PREFIX || 'rg', // namespaced keys: rg:<ns>:<id>
  },

  // Google Pub/Sub for decoupled background fan-out (payouts, FCM, recordings,
  // translation backfill). MOCK-safe: with PUBSUB_ENABLED off (or no creds) the
  // producers fall back to the Mongo job queue, so nothing breaks locally.
  // Billing (bill_tick) and ring_timeout NEVER use Pub/Sub — they need precise
  // future scheduling, which only the Mongo `nextRunAt` queue provides.
  pubsub: {
    enabled: process.env.PUBSUB_ENABLED === 'true',
    projectId: process.env.PUBSUB_PROJECT_ID || process.env.GCS_PROJECT_ID || '',
    // ADC on GCP; locally provide a key file or inline JSON (reuses GCS creds if shared).
    keyFile: process.env.PUBSUB_KEY_FILE || process.env.GCS_KEY_FILE || '',
    credentialsJson: process.env.PUBSUB_CREDENTIALS_JSON || process.env.GCS_CREDENTIALS_JSON || '',
    topicPrefix: process.env.PUBSUB_TOPIC_PREFIX || 'rg', // topics: rg-payouts, rg-notifications…
  },

  // Shared secret for internal-only endpoints (e.g. Cloud Scheduler → 3am
  // translation backfill). Cloud Scheduler sends it as a header; requests
  // without it are rejected. Empty in dev = endpoint open on localhost only.
  internalJobSecret: process.env.INTERNAL_JOB_SECRET || '',

  // BigQuery — append-only, analyze-later store for high-volume data that does
  // NOT belong in Mongo: API request logs, analytics (clicks/visits/signups),
  // and notification delivery events. Disabled by default; when off the writers
  // no-op so nothing breaks locally. Auth reuses the GCS service-account key.
  bigquery: {
    enabled: process.env.BQ_ENABLED === 'true',
    projectId: process.env.BQ_PROJECT_ID || process.env.GCS_PROJECT_ID || '',
    dataset: process.env.BQ_DATASET || 'rg_analytics',
    keyFile: process.env.BQ_KEY_FILE || process.env.GCS_KEY_FILE || '',
    credentialsJson: process.env.BQ_CREDENTIALS_JSON || process.env.GCS_CREDENTIALS_JSON || '',
    // Rows are buffered and flushed in batches to avoid per-request latency.
    flushIntervalMs: parseInt(process.env.BQ_FLUSH_INTERVAL_MS || '5000', 10),
    maxBuffer: parseInt(process.env.BQ_MAX_BUFFER || '500', 10),
  },

  // Google Analytics (GA4) Data API — pulls the Firebase Analytics metrics for
  // both apps into the admin's native charts. Disabled until GA4_PROPERTY_ID is
  // set AND the service account below is granted Viewer on that GA4 property.
  // Auth reuses the GCS/Firebase service-account key by default.
  ga4: {
    propertyId: process.env.GA4_PROPERTY_ID || '', // numeric GA4 property id (NOT the measurement id)
    keyFile: process.env.GA4_KEY_FILE || process.env.GCS_KEY_FILE || process.env.FIREBASE_KEY_FILE || './firebase-service-account.json',
    credentialsJson: process.env.GA4_CREDENTIALS_JSON || process.env.GCS_CREDENTIALS_JSON || '',
  },

  // ── SaaS control-plane (multi-tenant) ──────────────────────────────────────
  // The platform is multi-tenant with DB-per-tenant isolation. This block holds
  // ONLY platform-global infra; per-tenant secrets (Agora/PayU/WABridge/LLM)
  // live encrypted in the `saas_control` DB, NOT here. Firebase + GCS are shared
  // across all tenants (see notes in fcmService / uploadService).
  saas: {
    // Multi-tenant is OFF by default so the app still boots single-tenant during
    // the migration. When false, tenantResolver injects a single implicit tenant
    // ("default") backed by the legacy mongoUri, so existing behavior is intact.
    enabled: process.env.SAAS_ENABLED === 'true',

    // Control-plane database — the only truly-global collections (Tenant, Plan,
    // Subscription, TenantSecret, OwnerUser, BuildJob). Its own connection,
    // always-on. Defaults to a `saas_control` db on the same Mongo host.
    controlDbUri:
      process.env.SAAS_CONTROL_DB_URI ||
      process.env.CONTROL_MONGO_URI ||
      'mongodb://127.0.0.1:27017/saas_control',

    // Root domain that per-tenant subdomains hang off of (admin + landing).
    // e.g. rootDomain=example.com → <slug>.example.com landing,
    // <slug>.admin.example.com tenant admin, owner.example.com owner console.
    rootDomain: process.env.SAAS_ROOT_DOMAIN || '',

    // Max live per-tenant mongoose connections kept warm (LRU-evicted).
    maxTenantConnections: parseInt(process.env.SAAS_MAX_TENANT_CONNECTIONS || '50', 10),

    // Free-trial length applied to newly provisioned tenants.
    trialDays: parseInt(process.env.SAAS_TRIAL_DAYS || '14', 10),
    // Grace window after trial/period end before a tenant is hard-suspended.
    graceDays: parseInt(process.env.SAAS_GRACE_DAYS || '3', 10),

    // Separate JWT secret for platform-owner (OwnerUser) tokens so a leaked
    // tenant JWT secret can never mint an owner token. Falls back to jwt.secret.
    ownerJwtSecret: process.env.OWNER_JWT_SECRET || process.env.JWT_SECRET || 'dev_owner_secret_change_me',
  },

  // MongoDB Atlas Admin API — used by the provisioning service to auto-create a
  // database user (and thus an isolated database) per tenant on the shared
  // cluster. Programmatic API key (public+private) with Project Owner on the
  // Atlas project. When creds are absent, provisioning falls back to "same
  // cluster, new db name, no Atlas call" (dev-safe).
  atlas: {
    publicKey: process.env.ATLAS_PUBLIC_KEY || '',
    privateKey: process.env.ATLAS_PRIVATE_KEY || '',
    projectId: process.env.ATLAS_PROJECT_ID || '', // the Atlas Project (group) id
    // The SRV host tenants connect through, e.g. cluster0.abcde.mongodb.net.
    clusterHost: process.env.ATLAS_CLUSTER_HOST || '',
    baseUrl: process.env.ATLAS_BASE_URL || 'https://cloud.mongodb.com/api/atlas/v2',
  },

  // NOTE: admin-tunable values (withdrawal threshold, escalation thresholds,
  // signup bonus, gift token rate, ring timeout, max call minutes) live in the
  // `AdminSettings` collection so admins can change them at runtime via
  // PUT /api/admin/settings — they are intentionally NOT env vars.
  // The platform's commission is also not a global percentage; it is an
  // absolute ₹/min `adminCutPerMin` set per astrologer per service.
};

env.isDev = env.nodeEnv !== 'production';
env.isProd = env.nodeEnv === 'production';

// Origins allowed to embed the landing page (admin heatmap iframe).
// Comma-separated ADMIN_ORIGINS in prod; sensible Vite defaults in dev.
env.adminOrigins = (process.env.ADMIN_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (env.isDev && !env.adminOrigins.length) {
  env.adminOrigins = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'];
}

module.exports = env;
