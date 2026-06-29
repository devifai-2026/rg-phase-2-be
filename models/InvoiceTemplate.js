const mongoose = require('mongoose');

/**
 * Admin-managed invoice template. The admin can create a few (Rudraganga ships
 * 3 built-in designs), set their real business identity (logo, address, GSTIN,
 * etc.), pick which `design` to render, and mark ONE as default. The invoice
 * PDF generator uses the default (active) template to brand every invoice.
 */
const invoiceTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // admin label, e.g. "Main GST invoice"
    // Which built-in pdfkit layout to render: 1=Classic, 2=Modern, 3=Devotional.
    design: { type: Number, enum: [1, 2, 3], default: 1 },

    // Business identity printed on the invoice.
    businessName: { type: String, trim: true, default: 'Rudraganga' },
    logo: { type: String }, // GCS URL (admin upload)
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    gstin: { type: String, trim: true },
    footerNote: { type: String, trim: true, default: 'Thank you for choosing Rudraganga 🙏' },

    isDefault: { type: Boolean, default: false, index: true }, // exactly one should be true
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InvoiceTemplate', invoiceTemplateSchema);
