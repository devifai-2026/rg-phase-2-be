const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const aiMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'AiConversation', required: true, index: true },
    role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
    content: { type: String, required: true },
    tokens: { type: Number },
  },
  { timestamps: true }
);

aiMessageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = defineModel('AiMessage', aiMessageSchema);