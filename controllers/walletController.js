const asyncHandler = require('../utils/asyncHandler');
const walletService = require('../services/walletService');
const cacheService = require('../services/cacheService');

exports.getBalance = asyncHandler(async (req, res) => {
  const data = await walletService.getBalance(req.ctx, req.user._id);
  res.json({ success: true, data });
});

/**
 * App "Add money" packs — active recharge templates, ordered for display.
 * Cached in GCP Memorystore (long TTL) since packs are admin-managed and rarely
 * change. The cache is INVALIDATED whenever an admin creates/edits/deletes a
 * template (see adminController), so the app never serves stale packs. Falls
 * through to a direct Mongo read when the cache is off/unavailable.
 */
exports.listRechargeTemplates = asyncHandler(async (req, res) => {
  const items = await cacheService.withCache(req.ctx, 'recharge', 'active', 3600, async () => {
    const RechargeTemplate = req.model('RechargeTemplate');
    return RechargeTemplate.find({ isActive: true }).sort({ sortOrder: 1, amount: 1 }).lean();
  });
  res.json({ success: true, data: items });
});

exports.listTransactions = asyncHandler(async (req, res) => {
  const { page, limit, type, source, days } = req.query;
  const data = await walletService.listTransactions(req.ctx, req.user._id, {
    page: parseInt(page || '1', 10),
    limit: Math.min(parseInt(limit || '20', 10), 100),
    type,
    source,
    days: days ? parseInt(days, 10) : undefined,
  });
  res.json({ success: true, data });
});

/**
 * Invoice for one of MY wallet transactions (a recharge). Powers the app's
 * "Download invoice" button on a recharge row.
 *
 * The transaction id is the handle the app already has; the invoice is looked up
 * by the gateway txnid recorded on that row. Backfills on demand so recharges
 * made before invoicing existed still produce a document on first request.
 *
 * Returns { invoice, template } — the caller renders or opens `invoice.pdfUrl`.
 * pdfStatus is surfaced so the app can say "preparing…" rather than showing a
 * dead button while the async render job is still running.
 */
exports.getTransactionInvoice = asyncHandler(async (req, res) => {
  const AppError = require('../utils/AppError');
  const invoiceService = require('../services/invoiceService');
  const Transaction = req.model('Transaction');

  const txn = await Transaction.findById(req.params.id);
  if (!txn) throw new AppError('Transaction not found', 404);
  // Own rows only — an invoice carries the payer's billing details.
  if (String(txn.user) !== String(req.user._id)) throw new AppError('Not authorized', 403);
  if (txn.source !== 'recharge' || txn.type !== 'credit') {
    throw new AppError('Invoices are only issued for wallet recharges', 400);
  }

  // `refId` is the gateway txnid for a promoted recharge row; meta.txnid is the
  // fallback for rows written before promotion set it.
  const txnid = (txn.meta && txn.meta.txnid) || txn.refId;
  if (!txnid) throw new AppError('Invoice not available for this transaction', 404);

  const Invoice = req.model('Invoice');
  let invoice = await Invoice.findOne({ refType: 'recharge', paymentId: txnid });
  if (!invoice) {
    // Backfill for recharges that predate this feature.
    const User = req.model('User');
    const u = await User.findById(txn.user).select('name phone email');
    invoice = await invoiceService.createForRecharge(req.ctx, {
      userId: txn.user,
      txnid,
      tokens: txn.amount,
      paidRupees: txn.meta && txn.meta.paidRupees,
      packName: txn.meta && txn.meta.packName,
      billTo: u ? { name: u.name, phone: u.phone, email: u.email } : {},
    });
  }
  if (!invoice) throw new AppError('Invoice not available', 404);

  let template = null;
  if (invoice.template) template = await req.model('InvoiceTemplate').findById(invoice.template);
  if (!template) template = await invoiceService.defaultTemplate(req.ctx);

  res.json({ success: true, data: { invoice, template } });
});
