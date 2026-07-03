const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * A platform-owner account for the owner console (tenant provisioning, billing,
 * cross-tenant analytics, builds). Completely separate from tenant `User`s:
 * different collection, different DB (control-plane), password auth (not phone
 * OTP), and signed with saas.ownerJwtSecret — so a leaked tenant secret can
 * never mint an owner token.
 */
const ownerUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['owner', 'staff'], default: 'staff' }, // 'owner' = full; 'staff' = limited
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

/** Set the password (hashes it). */
ownerUserSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(String(plain), 10);
};

ownerUserSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(String(plain), this.passwordHash || '');
};

ownerUserSchema.methods.toSafeJSON = function () {
  return { id: String(this._id), email: this.email, name: this.name, role: this.role, isActive: this.isActive };
};

module.exports = ownerUserSchema;
