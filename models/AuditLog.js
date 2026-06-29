const mongoose = require('mongoose');

/**
 * Records privileged admin/super-admin actions for the Super Admin audit view.
 * e.g. "SuperAdmin_1 recharged User_X by 500", "Admin_Y deleted Astrologer_Z".
 */
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorRole: { type: String },
    action: { type: String, required: true }, // e.g. 'wallet.recharge', 'astrologer.delete', 'settings.update'
    targetType: { type: String }, // 'user' | 'astrologer' | 'product' | 'settings' | 'admin' ...
    target: { type: mongoose.Schema.Types.ObjectId },
    summary: { type: String }, // human-readable line
    meta: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
