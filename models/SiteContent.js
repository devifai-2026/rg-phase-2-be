const mongoose = require('mongoose');
const { defineModel } = require('./registry');

/**
 * Admin-editable CMS content the app fetches and displays: Contact Us, About,
 * Terms, Privacy, FAQ, etc. Keyed by a slug. `body` is free-form (HTML/markdown)
 * and `data` holds structured fields (e.g. contact email/phone/address).
 */
const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true }, // e.g. 'contact-us', 'about', 'terms', 'privacy', 'faq'
    title: { type: String },
    body: { type: String }, // HTML / markdown
    data: { type: mongoose.Schema.Types.Mixed }, // { email, phone, address, socials: {...} }
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = defineModel('SiteContent', siteContentSchema);