const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    // `kind` distinguishes a normal participant message from a system/context
    // message (e.g. the join-time birth-details prompt or the astrologer's
    // context card). System messages belong to the session, not a person, so
    // sender/receiver are only required for user messages.
    kind: { type: String, enum: ['user', 'system'], default: 'user' },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: function () { return this.kind !== 'system'; },
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: function () { return this.kind !== 'system'; },
    },
    // For system messages, which side should see it ('user' | 'astrologer' | 'both').
    audience: { type: String, enum: ['user', 'astrologer', 'both'], default: 'both' },
    message: { type: String, maxlength: 5000 },
    mediaUrl: { type: String },
    mediaType: { type: String },
    // A product the astrologer shared into the chat. Denormalized (name/price/
    // image captured at send time) so the card renders correctly even if the
    // product later changes or after the 7-day message TTL context is gone.
    // `productId` drives the user's tap-through to the product detail page.
    product: {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
      name: { type: String },
      price: { type: Number },
      image: { type: String },
      _id: false,
    },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

chatMessageSchema.index({ sessionId: 1, timestamp: -1 });
chatMessageSchema.index({ receiver: 1, status: 1 });
// 7-day retention: chat history older than a week auto-expires (TTL). Session
// records (durations/billing) persist; only the message bodies are removed.
chatMessageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
