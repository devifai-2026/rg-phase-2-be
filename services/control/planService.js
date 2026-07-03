const { Plan } = require('../../models/control');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Control-plane plan catalog. The built-in `free_trial` plan (14 days by
 * default, full features, no price) is seeded idempotently on boot so a newly
 * provisioned tenant always has a plan to start on. The owner can add paid plans
 * from the owner console.
 */
const BUILTIN_PLANS = [
  {
    key: 'free_trial',
    name: 'Free Trial',
    description: `${env.saas.trialDays}-day free trial with full features.`,
    price: 0,
    interval: 'trial',
    trialDays: env.saas.trialDays,
    features: { live: true, aiInsights: true, pooja: true, shop: true, matrimony: true },
    active: true,
    sortOrder: 0,
  },
];

/** Idempotently ensure the built-in plans exist. Safe to call on every boot. */
async function seedPlans() {
  for (const p of BUILTIN_PLANS) {
    await Plan.updateOne(
      { key: p.key },
      { $setOnInsert: p },
      { upsert: true }
    );
  }
  logger.info('Control-plane plans seeded', { count: BUILTIN_PLANS.length });
}

/** Fetch the trial plan (used by provisioning to start a tenant on trial). */
function getTrialPlan() {
  return Plan.findOne({ key: 'free_trial' });
}

module.exports = { seedPlans, getTrialPlan, BUILTIN_PLANS };
