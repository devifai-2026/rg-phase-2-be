const mongoose = require('mongoose');

/**
 * A tenant's billing state. This — not Tenant.status — is the gate the
 * tenantResolver checks: a subscription that is `suspended` (or a `trialing`
 * one past `trialEndsAt` with no grace left) blocks all tenant API/app traffic.
 *
 * Lifecycle: new tenant → `trialing` (trialEndsAt = now + plan.trialDays).
 * A daily `trial_sweep` job moves an expired trial → `past_due` (grace window)
 * → `suspended`. Assigning a paid plan + recording a payment → `active`.
 */
const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true }, // ₹
    currency: { type: String, default: 'INR' },
    method: { type: String, default: 'manual' }, // 'manual' | 'razorpay' | …
    reference: { type: String }, // gateway id / manual note
    paidAt: { type: Date, default: Date.now },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnerUser' },
  },
  { _id: true, timestamps: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true, index: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    planKey: { type: String }, // denormalized for quick reads

    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'suspended', 'cancelled'],
      default: 'trialing',
      index: true,
    },

    trialEndsAt: { type: Date },      // set on creation for the trial plan
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date }, // paid plans: end of the paid window
    // After a period/trial ends, tenant stays usable until this (grace) then suspends.
    graceUntil: { type: Date },

    cancelledAt: { type: Date },
    payments: { type: [paymentSchema], default: [] },
  },
  { timestamps: true }
);

/**
 * True when the tenant should be allowed through the gate right now. Suspended /
 * cancelled always fail. Trial passes until trialEndsAt (+ grace). Active passes
 * until currentPeriodEnd (+ grace). past_due passes only within graceUntil.
 */
subscriptionSchema.methods.isUsable = function (now = new Date()) {
  switch (this.status) {
    case 'suspended':
    case 'cancelled':
      return false;
    case 'trialing':
      return !this.trialEndsAt || now <= (this.graceUntil || this.trialEndsAt);
    case 'active':
      return !this.currentPeriodEnd || now <= (this.graceUntil || this.currentPeriodEnd);
    case 'past_due':
      return this.graceUntil ? now <= this.graceUntil : false;
    default:
      return false;
  }
};

module.exports = subscriptionSchema;
