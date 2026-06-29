const Invoice = require('../models/Invoice');
const InvoiceTemplate = require('../models/InvoiceTemplate');
const Counter = require('../models/Counter');
const invoicePdfService = require('./invoicePdfService');
const uploadService = require('./uploadService');
const jobService = require('./jobService');
const logger = require('../utils/logger');

/** Sequential invoice number: RG-INV-<year>-<6-digit seq>. */
async function nextInvoiceNo() {
  const year = new Date().getFullYear();
  const key = `invoice-${year}`;
  const c = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return `RG-INV-${year}-${String(c.seq).padStart(6, '0')}`;
}

/**
 * Create an invoice for a paid order (idempotent — one per order).
 * Called from the PayU callback when an order flips to paid.
 */
async function createForOrder(order) {
  const existing = await Invoice.findOne({ order: order._id });
  if (existing) return existing;

  const items = (order.items || []).map((it) => ({
    name: it.nameSnapshot,
    qty: it.qty,
    unitPrice: it.priceSnapshot,
    lineTotal: it.priceSnapshot * it.qty,
  }));
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const discount = Math.max(0, subtotal - order.total);

  // Stamp the template the invoice was generated with (the admin's default),
  // so it stays stable even if the default changes later.
  const tpl = await defaultTemplate();

  try {
    const invoice = await Invoice.create({
      invoiceNo: await nextInvoiceNo(),
      order: order._id,
      refType: 'order',
      refId: order._id,
      user: order.user,
      billTo: order.address,
      items,
      subtotal,
      discount,
      total: order.total,
      couponCode: order.couponCode,
      paymentId: order.paymentId,
      template: tpl && tpl._id ? tpl._id : undefined,
      pdfStatus: 'pending',
    });
    logger.info('Invoice generated', { invoiceNo: invoice.invoiceNo, order: String(order._id) });
    enqueuePdf(invoice._id);
    return invoice;
  } catch (e) {
    if (e.code === 11000) return Invoice.findOne({ order: order._id }); // race: another worker made it
    throw e;
  }
}

/**
 * Create an invoice for a paid pooja booking (idempotent per booking).
 * Called after the wallet debit confirms the booking.
 */
async function createForPooja(booking) {
  const existing = await Invoice.findOne({ refType: 'pooja', refId: booking._id });
  if (existing) return existing;

  const fam = (booking.familyMembers || []).filter(Boolean);
  const items = [{
    name: `Pooja: ${booking.poojaType}${fam.length ? ` (for ${fam.join(', ')})` : ''}`,
    qty: 1,
    unitPrice: booking.price,
    lineTotal: booking.price,
  }];
  const tpl = await defaultTemplate();
  try {
    const invoice = await Invoice.create({
      invoiceNo: await nextInvoiceNo(),
      refType: 'pooja',
      refId: booking._id,
      user: booking.user,
      billTo: { name: booking.contactName, phone: booking.contactPhone },
      items,
      subtotal: booking.price,
      discount: 0,
      total: booking.price,
      paymentId: booking.paymentId,
      template: tpl && tpl._id ? tpl._id : undefined,
      pdfStatus: 'pending',
    });
    logger.info('Invoice generated (pooja)', { invoiceNo: invoice.invoiceNo, booking: String(booking._id) });
    enqueuePdf(invoice._id);
    return invoice;
  } catch (e) {
    if (e.code === 11000) return Invoice.findOne({ refType: 'pooja', refId: booking._id });
    throw e;
  }
}

/** The active/default invoice template (or a sane built-in fallback). */
async function defaultTemplate() {
  return (await InvoiceTemplate.findOne({ isDefault: true, isActive: true }))
      || (await InvoiceTemplate.findOne({ isActive: true }).sort({ createdAt: 1 }))
      || { design: 1, businessName: 'Rudraganga', footerNote: 'Thank you for choosing Rudraganga 🙏' };
}

/** Enqueue async PDF generation (best-effort; never throws into the caller). */
function enqueuePdf(invoiceId) {
  jobService.enqueue({
    type: 'invoice_pdf',
    payload: { invoiceId: String(invoiceId) },
    dedupeKey: `invoice-pdf:${invoiceId}`,
  }).catch((e) => logger.warn('enqueue invoice_pdf failed', e.message));
}

/**
 * Job handler: render the invoice PDF with the active template, upload to GCS,
 * and save the URL. Idempotent — re-running just re-renders + overwrites the URL.
 */
async function generatePdf({ invoiceId }) {
  const invoice = await Invoice.findById(invoiceId).populate('template');
  if (!invoice) return;
  try {
    const tpl = invoice.template || (await defaultTemplate());
    const buffer = await invoicePdfService.render(invoice, tpl);
    const { url } = await uploadService.uploadToGcs(buffer, `invoice-${invoice.invoiceNo}.pdf`);
    invoice.pdfUrl = url;
    invoice.pdfStatus = 'ready';
    if (tpl && tpl._id) invoice.template = tpl._id;
    await invoice.save();
    logger.info('Invoice PDF ready', { invoiceNo: invoice.invoiceNo, url });
  } catch (e) {
    invoice.pdfStatus = 'failed';
    await invoice.save().catch(() => {});
    throw e; // let the job queue retry
  }
}

async function getByOrder(orderId) {
  return Invoice.findOne({ order: orderId });
}

module.exports = { createForOrder, createForPooja, generatePdf, defaultTemplate, getByOrder, nextInvoiceNo };
