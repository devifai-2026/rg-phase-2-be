const mongoose = require('mongoose');
const { defaultContext } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Hardened wallet ledger.
 *
 * Invariants:
 *  - All amounts are positive integer paise (whole rupees enforced by callers).
 *  - Every money movement carries a UNIQUE refId (idempotency key). Replays
 *    return the existing transaction instead of double-charging.
 *  - Balance can never go negative: debits use a conditional findOneAndUpdate
 *    ({ balance: { $gte: amount } }) so the guard is evaluated atomically by
 *    Mongo, immune to race conditions under concurrent requests.
 *  - When MONGO_TX_ENABLED, wallet + ledger writes are wrapped in a session so
 *    they commit together; otherwise we degrade gracefully (overdraft guard
 *    still intact; the unique refId prevents duplicate ledger rows).
 */

async function getOrCreateWallet(ctx, userId) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) {
    try {
      wallet = await Wallet.create({ user: userId });
    } catch (e) {
      if (e.code === 11000) wallet = await Wallet.findOne({ user: userId });
      else throw e;
    }
  }
  return wallet;
}

async function getBalance(ctx, userId) {
  ctx = ctx || defaultContext();
  const wallet = await getOrCreateWallet(ctx, userId);
  return {
    balance: wallet.balance,
    lockedBalance: wallet.lockedBalance,
    available: wallet.balance - wallet.lockedBalance,
  };
}

/** Idempotent: if a txn with refId exists, return it without re-applying. */
async function findByRef(ctx, refId) {
  ctx = ctx || defaultContext();
  const Transaction = ctx.model('Transaction');
  return Transaction.findOne({ refId });
}

function maybeSession() {
  return env.mongoTxEnabled ? mongoose.startSession() : Promise.resolve(null);
}

async function withTx(fn) {
  if (!env.mongoTxEnabled) return fn(null);
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    session.endSession();
  }
}

/** Credit funds into a wallet (recharge / refund / bonus / earnings / gift-receive). */
async function credit(ctx, { userId, amount, source, description, refId, relatedSession, meta }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  const Transaction = ctx.model('Transaction');
  if (!amount || amount < 1) throw new AppError('Invalid credit amount', 400);
  const existing = await findByRef(ctx, refId);
  if (existing) return existing;

  await getOrCreateWallet(ctx, userId);

  return withTx(async (session) => {
    const opts = session ? { new: true, session } : { new: true };
    const wallet = await Wallet.findOneAndUpdate({ user: userId }, { $inc: { balance: amount } }, opts);
    let txn;
    try {
      const created = await Transaction.create(
        [{ user: userId, type: 'credit', source, amount, status: 'completed', description, refId, relatedSession, balanceAfter: wallet.balance, meta }],
        session ? { session } : {}
      );
      txn = created[0];
    } catch (e) {
      if (e.code === 11000) {
        // Lost a race; another request already credited with this refId. Reverse our increment.
        if (!session) await Wallet.updateOne({ user: userId }, { $inc: { balance: -amount } });
        throw new AppError('Duplicate transaction', 409);
      }
      throw e;
    }
    return txn;
  });
}

/** Atomically debit if sufficient balance. Throws 402 if not enough. */
async function debit(ctx, { userId, amount, source, description, refId, relatedSession, meta }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  const Transaction = ctx.model('Transaction');
  if (!amount || amount < 1) throw new AppError('Invalid debit amount', 400);
  const existing = await findByRef(ctx, refId);
  if (existing) return existing;

  return withTx(async (session) => {
    const opts = session ? { new: true, session } : { new: true };
    const wallet = await Wallet.findOneAndUpdate(
      { user: userId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      opts
    );
    if (!wallet) throw new AppError('Insufficient balance', 402);

    let txn;
    try {
      const created = await Transaction.create(
        [{ user: userId, type: 'debit', source, amount, status: 'completed', description, refId, relatedSession, balanceAfter: wallet.balance, meta }],
        session ? { session } : {}
      );
      txn = created[0];
    } catch (e) {
      if (e.code === 11000) {
        if (!session) await Wallet.updateOne({ user: userId }, { $inc: { balance: amount } });
        return findByRef(ctx, refId);
      }
      throw e;
    }
    return txn;
  });
}

/** Reserve funds for an in-progress session / pending withdrawal (no ledger row). */
async function lock(ctx, { userId, amount }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  if (!amount || amount < 1) throw new AppError('Invalid lock amount', 400);
  const wallet = await Wallet.findOneAndUpdate(
    { user: userId, $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amount] } },
    { $inc: { lockedBalance: amount } },
    { new: true }
  );
  if (!wallet) throw new AppError('Insufficient balance to reserve', 402);
  return wallet;
}

/** Release a previously-locked reservation that was not spent. */
async function releaseLock(ctx, { userId, amount }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  if (!amount || amount < 1) return getOrCreateWallet(ctx, userId);
  return Wallet.findOneAndUpdate(
    { user: userId },
    [
      {
        $set: {
          lockedBalance: { $max: [0, { $subtract: ['$lockedBalance', amount] }] },
        },
      },
    ],
    { new: true }
  );
}

/**
 * Settle part of a reservation: deduct from BOTH balance and lockedBalance and
 * write a debit ledger row. Used by the per-minute billing tick.
 */
async function settleLocked(ctx, { userId, amount, source, description, refId, relatedSession, meta }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  const Transaction = ctx.model('Transaction');
  if (!amount || amount < 1) throw new AppError('Invalid settle amount', 400);
  const existing = await findByRef(ctx, refId);
  if (existing) return existing;

  return withTx(async (session) => {
    const opts = session ? { new: true, session } : { new: true };
    const wallet = await Wallet.findOneAndUpdate(
      { user: userId, balance: { $gte: amount }, lockedBalance: { $gte: amount } },
      { $inc: { balance: -amount, lockedBalance: -amount } },
      opts
    );
    if (!wallet) throw new AppError('Insufficient locked funds', 402);

    let txn;
    try {
      const created = await Transaction.create(
        [{ user: userId, type: 'debit', source, amount, status: 'completed', description, refId, relatedSession, balanceAfter: wallet.balance, meta }],
        session ? { session } : {}
      );
      txn = created[0];
    } catch (e) {
      if (e.code === 11000) {
        if (!session) await Wallet.updateOne({ user: userId }, { $inc: { balance: amount, lockedBalance: amount } });
        return findByRef(ctx, refId);
      }
      throw e;
    }
    return txn;
  });
}

async function listTransactions(ctx, userId, { page = 1, limit = 20, type, source, days } = {}) {
  ctx = ctx || defaultContext();
  const Transaction = ctx.model('Transaction');
  const q = { user: userId };
  if (type) q.type = type;
  if (source) q.source = source;
  // Optional rolling window (e.g. last 7/14/30 days).
  if (days && Number(days) > 0) {
    q.createdAt = { $gte: new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000) };
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Transaction.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Transaction.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

module.exports = {
  getOrCreateWallet,
  getBalance,
  credit,
  debit,
  lock,
  releaseLock,
  settleLocked,
  listTransactions,
};
