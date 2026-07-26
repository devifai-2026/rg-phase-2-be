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

/**
 * Run `fn` inside a transaction when MONGO_TX_ENABLED. The session MUST be
 * started on the SAME connection the models live on — under multi-tenancy the
 * wallet/ledger models come from the tenant connection (ctx.db), a different
 * MongoClient than the global `mongoose`. Starting the session on `mongoose`
 * and using it against tenant-connection collections throws
 * "ClientSession must be from the same MongoClient". So we start it on ctx.db.
 */
async function withTx(ctx, fn) {
  if (!env.mongoTxEnabled) return fn(null);
  const conn = (ctx && ctx.db) || mongoose.connection;
  const session = await conn.startSession();
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
async function credit(ctx, { userId, amount, source, description, refId, relatedSession, meta, promoteRefId }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  const Transaction = ctx.model('Transaction');
  if (!amount || amount < 1) throw new AppError('Invalid credit amount', 400);
  const existing = await findByRef(ctx, refId);
  if (existing) return existing;

  await getOrCreateWallet(ctx, userId);

  return withTx(ctx, async (session) => {
    const opts = session ? { new: true, session } : { new: true };
    const wallet = await Wallet.findOneAndUpdate({ user: userId }, { $inc: { balance: amount } }, opts);
    let txn;
    try {
      // `promoteRefId` names a pending INTENT row for this same payment (e.g.
      // "pending:<txnid>"). Promote it in place instead of inserting a second
      // document, so one payment is one ledger row. Without this a recharge
      // left two rows both reading "completed / credit / ₹99" — indistinguishable
      // from a double credit unless you noticed only one had balanceAfter.
      if (promoteRefId) {
        const promoted = await Transaction.findOneAndUpdate(
          { refId: promoteRefId, status: 'pending' },
          { $set: { refId, status: 'completed', balanceAfter: wallet.balance, source, description, amount, meta } },
          session ? { new: true, session } : { new: true }
        );
        if (promoted) return promoted;
        // No pending row (already promoted, or none written) — fall through and
        // insert; the refId unique index still prevents a duplicate credit.
      }
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

  return withTx(ctx, async (session) => {
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
async function settleLocked(ctx, { userId, amount, source, description, refId, relatedSession, meta, rollupRefId }) {
  ctx = ctx || defaultContext();
  const Wallet = ctx.model('Wallet');
  const Transaction = ctx.model('Transaction');
  if (!amount || amount < 1) throw new AppError('Invalid settle amount', 400);
  const existing = await findByRef(ctx, refId);
  if (existing) return existing;
  // Under roll-up the row is keyed by rollupRefId, so the findByRef above can't
  // see an already-billed minute. Check the recorded minute refs too, or a
  // replayed bill_tick would charge that minute twice.
  if (rollupRefId) {
    const already = await Transaction.findOne({ refId: rollupRefId, user: userId, 'meta.minuteRefs': refId }).lean();
    if (already) return already;
  }

  return withTx(ctx, async (session) => {
    const opts = session ? { new: true, session } : { new: true };
    const wallet = await Wallet.findOneAndUpdate(
      { user: userId, balance: { $gte: amount }, lockedBalance: { $gte: amount } },
      { $inc: { balance: -amount, lockedBalance: -amount } },
      opts
    );
    if (!wallet) throw new AppError('Insufficient locked funds', 402);

    // ROLL-UP: consultations bill once a MINUTE, which used to write one ledger
    // row per minute — a 2-minute chat showed as two identical "− ₹50" lines.
    // When rollupRefId is given, accumulate into that single per-session row so
    // the user sees one entry with the running total. `refId` stays per-minute
    // (in meta.minuteRefs) so an idempotent replay is still detectable.
    if (rollupRefId) {
      // Dot-path each meta key so $set updates fields individually instead of
      // replacing the whole object (which would drop meta.minuteRefs).
      const metaSet = Object.fromEntries(Object.entries(meta || {}).map(([k, v]) => [`meta.${k}`, v]));
      const rolled = await Transaction.findOneAndUpdate(
        { refId: rollupRefId, user: userId, type: 'debit' },
        {
          $inc: { amount },
          // Refresh meta (minutes/rate/type) so the row's "N min · ₹R/min"
          // detail tracks the session as it runs, without clobbering minuteRefs.
          $set: { balanceAfter: wallet.balance, description, status: 'completed', ...metaSet },
          $addToSet: { 'meta.minuteRefs': refId },
        },
        session ? { new: true, session } : { new: true }
      );
      if (rolled) return rolled;
      // First minute of this session — fall through and create the row below,
      // keyed by rollupRefId so subsequent minutes find and extend it.
    }

    let txn;
    try {
      const created = await Transaction.create(
        [{
          user: userId,
          type: 'debit',
          source,
          amount,
          status: 'completed',
          description,
          refId: rollupRefId || refId,
          relatedSession,
          balanceAfter: wallet.balance,
          meta: rollupRefId ? { ...(meta || {}), minuteRefs: [refId] } : meta,
        }],
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
  // Hide un-settled money from the user's history. A recharge writes a
  // `pending` intent BEFORE the gateway confirms, so listing it made an
  // unpaid (or failed) attempt look like a credit that had landed.
  // Only settled rows belong in a statement.
  const q = { user: userId, status: { $nin: ['pending', 'failed'] } };
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
  findByRef,
  credit,
  debit,
  lock,
  releaseLock,
  settleLocked,
  listTransactions,
};
