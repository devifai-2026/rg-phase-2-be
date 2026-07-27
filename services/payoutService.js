const axios = require('axios');
const walletService = require('./walletService');
const notificationService = require('./notificationService');
const pubsubService = require('./pubsubService');
const { toRupees } = require('../utils/money');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');
const { defaultContext } = require('../utils/tenantContext');
const cacheService = require('./cacheService');

function isConfigured() {
  return !!(env.payu.payout.clientId && env.payu.payout.clientSecret);
}

/** Astrologer requests a withdrawal. Locks the funds; admin must approve.
 *  If no bank details are passed, fall back to the saved payout details — and
 *  require that at least one of them exists (no payout without an account). */
async function requestWithdrawal(ctx, { astrologerUserId, amount, bankAccountDetails }) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  const AdminSettings = ctx.model('AdminSettings');
  const settings = await cacheService.config(ctx, 'AdminSettings');
  if (amount < settings.withdrawalThreshold) {
    throw new AppError(`Minimum withdrawal is ₹${settings.withdrawalThreshold}`, 400);
  }

  // ONE open request at a time. Each request LOCKS the amount (below), so without
  // this an astrologer could stack requests until their whole balance was locked,
  // and the admin would be working through a queue of overlapping payouts for the
  // same earnings. 'approved' counts as open too — the money is still in flight.
  const open = await WithdrawalRequest.findOne({
    astrologer: astrologerUserId,
    status: { $in: ['pending', 'approved'] },
  }).select('_id amount status').lean();
  if (open) {
    throw new AppError(
      `You already have a withdrawal of ₹${open.amount} awaiting processing. Please wait for it to complete.`,
      409,
    );
  }

  // Resolve the payout target: explicit details, else the saved profile ones.
  let bank = bankAccountDetails;
  if (!bank || (!bank.accountNumber && !bank.upi)) {
    const AstrologerProfile = ctx.model('AstrologerProfile');
    const prof = await AstrologerProfile.findOne({ user: astrologerUserId }).select('payoutDetails').lean();
    const pd = prof && prof.payoutDetails;
    if (!pd || (!pd.accountNumber && !pd.upi)) {
      throw new AppError('Add a bank account or UPI before requesting a withdrawal.', 400);
    }
    bank = { accountNumber: pd.accountNumber, ifsc: pd.ifsc, name: pd.beneficiaryName, upi: pd.upi };
  }

  const { available } = await walletService.getBalance(ctx, astrologerUserId);
  if (available < amount) throw new AppError('Insufficient earnings to withdraw', 402);

  // Lock the funds so they can't be spent elsewhere while in flight.
  await walletService.lock(ctx, { userId: astrologerUserId, amount });

  const wr = await WithdrawalRequest.create({
    astrologer: astrologerUserId,
    amount,
    bankAccountDetails: bank,
    status: 'pending',
  });
  await notificationService.notify(ctx, astrologerUserId, {
    type: 'withdrawal_status',
    title: 'Withdrawal requested',
    body: `Your withdrawal of ₹${amount} is pending approval.`,
    data: { withdrawalId: String(wr._id) },
  });
  // Live admin-console badge + bell.
  require('../websockets/emit').adminActivity(ctx, 'withdrawal', { id: wr._id, title: `Withdrawal ₹${amount} pending` });
  return wr;
}

/** Admin approves -> enqueue the payout job (idempotent by withdrawal id). */
async function approveWithdrawal(ctx, withdrawalId, adminId, note) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr) throw new AppError('Withdrawal not found', 404);
  if (wr.status !== 'pending') throw new AppError(`Cannot approve a ${wr.status} withdrawal`, 409);

  wr.status = 'approved';
  wr.adminNote = note;
  wr.processedBy = adminId;
  await wr.save();

  // Tell the astrologer their request was approved. Previously ONLY the reject,
  // paid and failed transitions notified, so an approval was silent — the
  // astrologer saw nothing between requesting and the money landing (which can
  // be a while, since the payout runs as a queued job that may retry). Best
  // effort: a notification failure must never block the payout itself.
  try {
    await notificationService.notify(ctx, wr.astrologer, {
      type: 'withdrawal_status',
      title: 'Withdrawal approved',
      body: `₹${toRupees(wr.amount)} approved. The transfer to your account is being processed.`,
      data: { withdrawalId: String(wr._id), status: 'approved', deeplink: 'rudraganga://astro/earnings' },
    });
  } catch (e) {
    logger.warn('withdrawal approved notify failed', e.message);
  }

  // Pub/Sub fan-out (retries + DLQ via the subscription); falls back to the
  // Mongo queue if Pub/Sub is off. Idempotent: the handler dedupes by refId.
  await pubsubService.publish('payouts', { withdrawalId: String(wr._id) }, { dedupeKey: `payout:${wr._id}`, tenantSlug: ctx && ctx.tenant && ctx.tenant.slug });
  return wr;
}

async function rejectWithdrawal(ctx, withdrawalId, adminId, note) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr) throw new AppError('Withdrawal not found', 404);
  if (!['pending', 'approved'].includes(wr.status)) throw new AppError(`Cannot reject a ${wr.status} withdrawal`, 409);

  await walletService.releaseLock(ctx, { userId: wr.astrologer, amount: wr.amount });
  wr.status = 'rejected';
  wr.adminNote = note;
  wr.processedBy = adminId;
  wr.processedAt = new Date();
  await wr.save();
  // The amount is already back in their wallet at this point, so say so —
  // "rejected" alone reads like the money is gone.
  try {
    await notificationService.notify(ctx, wr.astrologer, {
      type: 'withdrawal_status',
      title: 'Withdrawal rejected',
      body: note
        ? `${note} ₹${toRupees(wr.amount)} has been returned to your wallet.`
        : `Your withdrawal request was rejected. ₹${toRupees(wr.amount)} has been returned to your wallet.`,
      data: { withdrawalId: String(wr._id), status: 'rejected', deeplink: 'rudraganga://astro/earnings' },
    });
  } catch (e) {
    logger.warn('withdrawal rejected notify failed', e.message);
  }
  return wr;
}

/** Job handler: actually settle via PayU Payout. Retries on failure via queue. */
async function runPayout(ctx, { withdrawalId }) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr) return { skipped: 'not found' };
  if (wr.status === 'paid') return { skipped: 'already paid' };

  await WithdrawalRequest.updateOne({ _id: wr._id }, { $set: { status: 'processing' } });

  let payoutRef;
  if (!isConfigured()) {
    logger.warn('[Payout MOCK] settling withdrawal', { withdrawalId, amount: wr.amount });
    payoutRef = `mock_payout_${wr._id}`;
  } else {
    // Real PayU Payout call (Wibmo/PayU disbursements). Endpoint/payload depend
    // on the merchant's onboarding; this is the standard transfer shape.
    const resp = await axios.post(
      `${env.payu.payout.baseUrl}/payout/v2/transfers`,
      {
        merchantRefId: String(wr._id),
        amount: toRupees(wr.amount),
        purpose: 'astrologer_settlement',
        beneficiary: {
          name: wr.bankAccountDetails.name,
          accountNumber: wr.bankAccountDetails.accountNumber,
          ifsc: wr.bankAccountDetails.ifsc,
          upi: wr.bankAccountDetails.upi,
        },
      },
      {
        headers: { Authorization: `Bearer ${env.payu.payout.clientSecret}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    payoutRef = (resp.data && (resp.data.referenceId || resp.data.transferId)) || `payu_${wr._id}`;
  }

  // Settle the locked funds out of the wallet (idempotent debit).
  await walletService.settleLocked(ctx, {
    userId: wr.astrologer,
    amount: wr.amount,
    source: 'withdrawal',
    description: `Withdrawal payout ${payoutRef}`,
    refId: `withdrawal:${wr._id}`,
  });

  await WithdrawalRequest.updateOne(
    { _id: wr._id },
    { $set: { status: 'paid', payoutRef, processedAt: new Date() } }
  );
  // Best-effort: the money HAS moved and the row is already marked paid. Throwing
  // here would fail the job and retry a completed payout.
  try {
    await notificationService.notify(ctx, wr.astrologer, {
      type: 'withdrawal_status',
      title: 'Withdrawal paid',
      body: `₹${toRupees(wr.amount)} has been transferred to your account.`,
      data: { withdrawalId: String(wr._id), payoutRef, status: 'paid', deeplink: 'rudraganga://astro/earnings' },
    });
  } catch (e) {
    logger.warn('withdrawal paid notify failed', e.message);
  }
  return { paid: true, payoutRef };
}

/** Called by jobWorker when payout permanently fails — release lock + alert. */
async function onPayoutFailed(ctx, { withdrawalId }, errorMessage) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr || wr.status === 'paid') return;
  await walletService.releaseLock(ctx, { userId: wr.astrologer, amount: wr.amount });
  await WithdrawalRequest.updateOne({ _id: wr._id }, { $set: { status: 'failed', adminNote: errorMessage } });
  try {
    await notificationService.notify(ctx, wr.astrologer, {
      type: 'withdrawal_status',
      title: 'Withdrawal failed',
      body: `We could not process your withdrawal. ₹${toRupees(wr.amount)} has been returned to your wallet.`,
      data: { withdrawalId: String(wr._id), status: 'failed', deeplink: 'rudraganga://astro/earnings' },
    });
  } catch (e) {
    logger.warn('withdrawal failed notify failed', e.message);
  }
}

async function listMine(ctx, astrologerUserId) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  return WithdrawalRequest.find({ astrologer: astrologerUserId }).sort({ createdAt: -1 });
}

async function adminList(ctx, { status, page = 1, limit = 20 } = {}) {
  ctx = ctx || defaultContext();
  const WithdrawalRequest = ctx.model('WithdrawalRequest');
  const q = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    WithdrawalRequest.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('astrologer', 'name phone'),
    WithdrawalRequest.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

module.exports = {
  isConfigured,
  requestWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  runPayout,
  onPayoutFailed,
  listMine,
  adminList,
};
