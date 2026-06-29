const axios = require('axios');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const AdminSettings = require('../models/AdminSettings');
const walletService = require('./walletService');
const notificationService = require('./notificationService');
const pubsubService = require('./pubsubService');
const { toRupees } = require('../utils/money');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');

function isConfigured() {
  return !!(env.payu.payout.clientId && env.payu.payout.clientSecret);
}

/** Astrologer requests a withdrawal. Locks the funds; admin must approve.
 *  If no bank details are passed, fall back to the saved payout details — and
 *  require that at least one of them exists (no payout without an account). */
async function requestWithdrawal({ astrologerUserId, amount, bankAccountDetails }) {
  const settings = await AdminSettings.get();
  if (amount < settings.withdrawalThreshold) {
    throw new AppError(`Minimum withdrawal is ₹${settings.withdrawalThreshold}`, 400);
  }

  // Resolve the payout target: explicit details, else the saved profile ones.
  let bank = bankAccountDetails;
  if (!bank || (!bank.accountNumber && !bank.upi)) {
    const AstrologerProfile = require('../models/AstrologerProfile');
    const prof = await AstrologerProfile.findOne({ user: astrologerUserId }).select('payoutDetails').lean();
    const pd = prof && prof.payoutDetails;
    if (!pd || (!pd.accountNumber && !pd.upi)) {
      throw new AppError('Add a bank account or UPI before requesting a withdrawal.', 400);
    }
    bank = { accountNumber: pd.accountNumber, ifsc: pd.ifsc, name: pd.beneficiaryName, upi: pd.upi };
  }

  const { available } = await walletService.getBalance(astrologerUserId);
  if (available < amount) throw new AppError('Insufficient earnings to withdraw', 402);

  // Lock the funds so they can't be spent elsewhere while in flight.
  await walletService.lock({ userId: astrologerUserId, amount });

  const wr = await WithdrawalRequest.create({
    astrologer: astrologerUserId,
    amount,
    bankAccountDetails: bank,
    status: 'pending',
  });
  await notificationService.notify(astrologerUserId, {
    type: 'withdrawal_status',
    title: 'Withdrawal requested',
    body: `Your withdrawal of ₹${amount} is pending approval.`,
    data: { withdrawalId: String(wr._id) },
  });
  // Live admin-console badge + bell.
  require('../websockets/emit').adminActivity('withdrawal', { id: wr._id, title: `Withdrawal ₹${amount} pending` });
  return wr;
}

/** Admin approves -> enqueue the payout job (idempotent by withdrawal id). */
async function approveWithdrawal(withdrawalId, adminId, note) {
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr) throw new AppError('Withdrawal not found', 404);
  if (wr.status !== 'pending') throw new AppError(`Cannot approve a ${wr.status} withdrawal`, 409);

  wr.status = 'approved';
  wr.adminNote = note;
  wr.processedBy = adminId;
  await wr.save();

  // Pub/Sub fan-out (retries + DLQ via the subscription); falls back to the
  // Mongo queue if Pub/Sub is off. Idempotent: the handler dedupes by refId.
  await pubsubService.publish('payouts', { withdrawalId: String(wr._id) }, { dedupeKey: `payout:${wr._id}` });
  return wr;
}

async function rejectWithdrawal(withdrawalId, adminId, note) {
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr) throw new AppError('Withdrawal not found', 404);
  if (!['pending', 'approved'].includes(wr.status)) throw new AppError(`Cannot reject a ${wr.status} withdrawal`, 409);

  await walletService.releaseLock({ userId: wr.astrologer, amount: wr.amount });
  wr.status = 'rejected';
  wr.adminNote = note;
  wr.processedBy = adminId;
  wr.processedAt = new Date();
  await wr.save();
  await notificationService.notify(wr.astrologer, {
    type: 'withdrawal_status',
    title: 'Withdrawal rejected',
    body: note || 'Your withdrawal request was rejected.',
    data: { withdrawalId: String(wr._id) },
  });
  return wr;
}

/** Job handler: actually settle via PayU Payout. Retries on failure via queue. */
async function runPayout({ withdrawalId }) {
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
  await walletService.settleLocked({
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
  await notificationService.notify(wr.astrologer, {
    type: 'withdrawal_status',
    title: 'Withdrawal paid',
    body: `₹${toRupees(wr.amount)} has been transferred to your account.`,
    data: { withdrawalId: String(wr._id), payoutRef },
  });
  return { paid: true, payoutRef };
}

/** Called by jobWorker when payout permanently fails — release lock + alert. */
async function onPayoutFailed({ withdrawalId }, errorMessage) {
  const wr = await WithdrawalRequest.findById(withdrawalId);
  if (!wr || wr.status === 'paid') return;
  await walletService.releaseLock({ userId: wr.astrologer, amount: wr.amount });
  await WithdrawalRequest.updateOne({ _id: wr._id }, { $set: { status: 'failed', adminNote: errorMessage } });
  await notificationService.notify(wr.astrologer, {
    type: 'withdrawal_status',
    title: 'Withdrawal failed',
    body: 'We could not process your withdrawal. The amount has been returned to your wallet.',
    data: { withdrawalId: String(wr._id) },
  });
}

async function listMine(astrologerUserId) {
  return WithdrawalRequest.find({ astrologer: astrologerUserId }).sort({ createdAt: -1 });
}

async function adminList({ status, page = 1, limit = 20 } = {}) {
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
