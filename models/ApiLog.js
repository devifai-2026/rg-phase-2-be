const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const apiLogSchema = new mongoose.Schema(
  {
    requestId: { type: String },
    method: { type: String },
    path: { type: String },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: Number },
    ms: { type: Number },
    ip: { type: String },
  },
  { timestamps: true }
);

// Auto-expire audit rows after 30 days.
apiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = defineModel('ApiLog', apiLogSchema);