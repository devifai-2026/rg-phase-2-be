const mongoose = require('mongoose');

const poojaBookingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    poojaType: { type: String, required: true }, // name snapshot (kept for display)
    poojaTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PoojaType', index: true },
    // Booker's contact snapshot (prefilled from the user in the app).
    contactName: { type: String },
    contactPhone: { type: String },
    // Family members the pooja is performed for (0..maxPersons of the PoojaType).
    familyMembers: { type: [String], default: [] },
    preferredDate: { type: Date },
    // Lifecycle: requested → confirmed (paid) → contacted (astrologer reached the
    // seeker) → done. 'completed'/'cancelled' kept for legacy rows. Admin-controlled.
    status: { type: String, enum: ['requested', 'confirmed', 'contacted', 'done', 'completed', 'cancelled'], default: 'requested', index: true },
    price: { type: Number, required: true, set: (v) => Math.round(Number(v) || 0) }, // whole rupees
    paymentId: { type: String },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    specialInstructions: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PoojaBooking', poojaBookingSchema);
