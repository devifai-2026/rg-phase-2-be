const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Auto-generated when an order is paid. Immutable snapshot of the billed order
 * for the admin Orders view and customer download. Amounts are whole rupees.
 */
const invoiceItemSchema = new mongoose.Schema(
  {
    name: { type: String },
    qty: { type: Number },
    unitPrice: { type: Number },
    lineTotal: { type: Number },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNo: { type: String, required: true, unique: true, index: true }, // e.g. RG-INV-2026-000123
    // `order` kept (sparse-unique) for existing order invoices; new invoices use
    // refType + refId so orders AND pooja bookings both fit one model.
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    refType: { type: String, enum: ['order', 'pooja', 'recharge'], index: true },
    refId: { type: mongoose.Schema.Types.ObjectId, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    billTo: {
      name: String, phone: String, line1: String, line2: String, city: String, state: String, pincode: String,
    },
    items: [invoiceItemSchema],
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    /**
     * GST breakdown, when the tenant has it enabled. Absent means "not a taxable
     * invoice" and the PDF prints no tax lines at all.
     *
     * Stored rather than recomputed at render time, because a tax invoice must
     * keep showing the rate that applied on the day it was issued even if the
     * admin later changes it.
     *   { rate, taxable, cgst, sgst }  intra-state
     *   { rate, taxable, igst }        inter-state
     */
    tax: {
      rate: { type: Number },
      taxable: { type: Number },
      cgst: { type: Number },
      sgst: { type: Number },
      igst: { type: Number },
    },
    couponCode: { type: String },
    paymentId: { type: String },
    // Generated PDF (async via the invoice_pdf job).
    pdfUrl: { type: String },
    pdfStatus: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending', index: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'InvoiceTemplate' },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One invoice per (refType, refId). Sparse so legacy order-only docs are fine.
invoiceSchema.index({ refType: 1, refId: 1 }, { unique: true, sparse: true });

module.exports = defineModel('Invoice', invoiceSchema);