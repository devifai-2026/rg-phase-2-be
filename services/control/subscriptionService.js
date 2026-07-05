const { Subscription, Plan, Tenant } = require('../../models/control');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { invalidateTenant } = require('../../middlewares/tenantResolver');

/**
 * Tenant billing lifecycle. A subscription is the gate the tenantResolver checks
 * (Subscription.isUsable()). New tenants start on the trial; a daily sweep moves
 * expired trials/periods through grace → suspended.
 */

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Add whole calendar months, clamping the day (e.g. Jan 31 +1mo → Feb 28/29).
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** Start a tenant on the free trial. Called during provisioning. */
async function startTrial(tenantId, now = new Date()) {
  const plan = await Plan.findOne({ key: 'free_trial' });
  if (!plan) throw new Error('free_trial plan not seeded');
  const trialEndsAt = addDays(now, plan.trialDays || env.saas.trialDays);
  const sub = await Subscription.findOneAndUpdate(
    { tenant: tenantId },
    {
      tenant: tenantId,
      plan: plan._id,
      planKey: plan.key,
      status: 'trialing',
      trialEndsAt,
      graceUntil: addDays(trialEndsAt, env.saas.graceDays),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Tenant.updateOne({ _id: tenantId }, { $set: { subscription: sub._id } });
  return sub;
}

/** Assign a paid plan + record a payment; activates the subscription. */
async function activatePaidPlan(tenantId, planKey, { periodDays = 30, payment } = {}, now = new Date()) {
  const plan = await Plan.findOne({ key: planKey });
  if (!plan) throw new Error(`Unknown plan "${planKey}"`);
  const currentPeriodEnd = addDays(now, periodDays);
  const update = {
    plan: plan._id,
    planKey: plan.key,
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd,
    graceUntil: addDays(currentPeriodEnd, env.saas.graceDays),
  };
  const sub = await Subscription.findOneAndUpdate({ tenant: tenantId }, update, { upsert: true, new: true });
  if (payment) {
    sub.payments.push({ ...payment, periodStart: now, periodEnd: currentPeriodEnd });
    await sub.save();
  }
  await afterChange(tenantId);
  return sub;
}

async function setStatus(tenantId, status) {
  const sub = await Subscription.findOneAndUpdate({ tenant: tenantId }, { status }, { new: true });
  await afterChange(tenantId);
  return sub;
}

/**
 * Record a monthly payment. Advances the paid period by ONE calendar month from
 * the LATER of (current period end, now) so consecutive on-time payments don't
 * lose days and a late payment starts fresh from today. Sets status → active.
 * `payment` = { amount, method?, reference? }. Returns the updated subscription.
 */
async function recordPayment(tenantId, payment, planKey, now = new Date()) {
  const sub = await Subscription.findOne({ tenant: tenantId });
  if (!sub) throw new Error('No subscription for tenant');
  // New period starts where the last one ended if still in the future, else now.
  const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const periodStart = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const periodEnd = addMonths(base, 1);
  if (planKey) {
    const plan = await Plan.findOne({ key: planKey });
    if (plan) { sub.plan = plan._id; sub.planKey = plan.key; }
  }
  sub.status = 'active';
  sub.currentPeriodStart = sub.currentPeriodStart || now;
  sub.currentPeriodEnd = periodEnd;
  sub.graceUntil = addDays(periodEnd, env.saas.graceDays);
  sub.payments.push({
    amount: Number(payment.amount) || 0,
    currency: payment.currency || 'INR',
    method: payment.method || 'manual',
    reference: payment.reference || '',
    paidAt: now,
    periodStart,
    periodEnd,
    recordedBy: payment.recordedBy,
  });
  await sub.save();
  await afterChange(tenantId);
  return sub;
}

/** Reactivate a suspended/cancelled subscription (used after un-suspending). */
async function reactivate(tenantId) {
  const sub = await Subscription.findOne({ tenant: tenantId });
  if (!sub) return null;
  const now = new Date();
  // If the paid period is still valid → active; else back to past_due so the
  // owner records a payment. Trial that hasn't expired → trialing.
  if (sub.currentPeriodEnd && sub.currentPeriodEnd > now) sub.status = 'active';
  else if (sub.trialEndsAt && sub.trialEndsAt > now) sub.status = 'trialing';
  else sub.status = 'past_due';
  await sub.save();
  await afterChange(tenantId);
  return sub;
}

/** Invalidate the resolver cache so a status/plan change takes effect at once. */
async function afterChange(tenantId) {
  const t = await Tenant.findById(tenantId).select('slug');
  if (t) invalidateTenant(t.slug);
}

/**
 * Daily sweep: transition expired trials/periods. Idempotent — safe to run on a
 * schedule. `trialing`/`active` past their end but within grace → `past_due`;
 * past grace → `suspended`.
 */
async function sweepExpired(now = new Date()) {
  let pastDue = 0;
  let suspended = 0;

  // trialing/active whose window ended but grace remains → past_due
  const toPastDue = await Subscription.find({
    status: { $in: ['trialing', 'active'] },
    $or: [
      { status: 'trialing', trialEndsAt: { $lte: now } },
      { status: 'active', currentPeriodEnd: { $lte: now } },
    ],
  });
  for (const sub of toPastDue) {
    sub.status = 'past_due';
    await sub.save();
    await afterChange(sub.tenant);
    pastDue++;
  }

  // past_due past grace → suspended
  const toSuspend = await Subscription.find({ status: 'past_due', graceUntil: { $lte: now } });
  for (const sub of toSuspend) {
    sub.status = 'suspended';
    await sub.save();
    await afterChange(sub.tenant);
    suspended++;
  }

  if (pastDue || suspended) logger.info('Subscription sweep', { pastDue, suspended });
  return { pastDue, suspended };
}

module.exports = { startTrial, activatePaidPlan, setStatus, recordPayment, reactivate, sweepExpired, addDays, addMonths };
