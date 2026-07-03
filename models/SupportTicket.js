const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const supportMessageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromRole: { type: String, enum: ['user', 'astrologer', 'admin'] },
    message: { type: String, required: true, maxlength: 5000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Help & support ticket submitted by a user OR astrologer. Admin views and
 * replies. Threaded with messages.
 */
const supportTicketSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['user', 'astrologer', 'admin'] }, // who raised it
    category: { type: String, enum: ['payment', 'call', 'account', 'kyc', 'payout', 'technical', 'other'], default: 'other' },
    subject: { type: String, required: true, maxlength: 200 },
    description: { type: String, required: true, maxlength: 5000 },
    attachments: [{ type: String }],
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    messages: [supportMessageSchema],
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ user: 1, createdAt: -1 });

module.exports = defineModel('SupportTicket', supportTicketSchema);