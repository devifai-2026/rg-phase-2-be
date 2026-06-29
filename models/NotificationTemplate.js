const mongoose = require('mongoose');

/**
 * System notification templates — one per platform event. The super-admin edits
 * the copy/image and toggles each on/off from Admin → Notifications → Templates.
 * When an event fires, the matching template (if enabled) is rendered with
 * `{{placeholder}}` substitution and sent via notificationService.notify().
 *
 * Audience is fixed per event (a recharge notification always goes to the user
 * who recharged) — `audience` here just records the natural target for display.
 */
const EVENTS = [
  'recharge_success', // user recharged wallet (PayU success)
  'offer_created',    // admin created a coupon or bundle
  'product_added',    // admin added a product
  'user_signup',      // a new user verified their phone
  'astrologer_signup',// a new astrologer was onboarded
];

// Human-friendly metadata so the admin UI can render labels + available vars
// without hardcoding them on the frontend.
const EVENT_META = {
  recharge_success: { label: 'Recharge successful', audience: 'user', vars: ['name', 'amount', 'balance'] },
  offer_created: { label: 'New offer created', audience: 'users', vars: ['code', 'title', 'discount'] },
  product_added: { label: 'New product added', audience: 'users', vars: ['productName', 'price'] },
  user_signup: { label: 'New user signup (welcome)', audience: 'user', vars: ['name'] },
  astrologer_signup: { label: 'New astrologer signup (welcome)', audience: 'astrologer', vars: ['name'] },
};

const notificationTemplateSchema = new mongoose.Schema(
  {
    event: { type: String, enum: EVENTS, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    title: { type: String, required: true },
    body: { type: String },
    audience: { type: String, default: 'user' }, // informational; natural target of the event
  },
  { timestamps: true }
);

// Defaults seeded on first read so the Templates tab is never empty.
const DEFAULTS = {
  recharge_success: { title: 'Recharge successful 🎉', body: 'Hi {{name}}, ₹{{amount}} was added to your wallet. New balance: ₹{{balance}}.' },
  offer_created: { title: 'New offer just dropped! 🎁', body: 'Use code {{code}} to save {{discount}}. Limited time only.' },
  product_added: { title: 'New in store ✨', body: '{{productName}} is now available for ₹{{price}}. Check it out!' },
  user_signup: { title: 'Welcome to Rudraganga 🙏', body: 'Hi {{name}}, your spiritual journey begins here. Talk to expert astrologers anytime.' },
  astrologer_signup: { title: 'Welcome aboard, {{name}}! 🌟', body: 'Your astrologer account is ready. Go online to start receiving consultations.' },
};

/** Ensure all event templates exist (idempotent); returns them sorted by event. */
notificationTemplateSchema.statics.ensureSeeded = async function () {
  const existing = await this.find();
  const have = new Set(existing.map((t) => t.event));
  const missing = EVENTS.filter((e) => !have.has(e)).map((e) => ({
    event: e,
    enabled: false,
    audience: EVENT_META[e].audience,
    ...DEFAULTS[e],
  }));
  if (missing.length) await this.insertMany(missing);
  return this.find().sort({ event: 1 });
};

/** Fetch a single enabled template for an event, or null. */
notificationTemplateSchema.statics.getEnabled = async function (event) {
  return this.findOne({ event, enabled: true });
};

module.exports = mongoose.model('NotificationTemplate', notificationTemplateSchema);
module.exports.EVENTS = EVENTS;
module.exports.EVENT_META = EVENT_META;
