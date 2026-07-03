const AppError = require('../utils/AppError');
const { filterMessage } = require('../utils/chatFilter');
const { defaultContext } = require('../utils/tenantContext');

/**
 * Resolve a product the ASTROLOGER is sharing into the chat, returning the
 * denormalized card. Only the astrologer may share, and only from their own
 * approved storefront OR the global RudraMaal (admin) catalogue — the same set
 * the AI recap suggests from. Throws if the product isn't shareable.
 */
async function resolveSharedProduct(ctx, productId, senderId, session) {
  ctx = ctx || defaultContext();
  const Product = ctx.model('Product');
  if (String(session.astrologer) !== String(senderId)) {
    throw new AppError('Only the astrologer can share a product', 403);
  }
  const p = await Product.findById(productId).select('name price images astrologer isActive status stock');
  if (!p || !p.isActive) throw new AppError('Product not available', 404);
  const isOwn = p.astrologer && String(p.astrologer) === String(senderId) && p.status === 'approved';
  const isRudraMaal = !p.astrologer; // admin catalogue
  if (!isOwn && !isRudraMaal) throw new AppError('You can only share your storefront or RudraMaal products', 403);
  return {
    productId: p._id,
    name: p.name,
    price: p.price,
    image: Array.isArray(p.images) && p.images.length ? p.images[0] : undefined,
  };
}

/** Persist a chat message inside an ongoing session. Text is moderated:
 *  phone numbers (10+ digits) and links are masked before storing/delivering.
 *  Birth dates/times/places are NOT restricted. An optional `productId` lets the
 *  astrologer share a storefront / RudraMaal product as a tappable card. */
async function persist(ctx, { sessionId, senderId, message, mediaUrl, mediaType, productId }) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const ChatMessage = ctx.model('ChatMessage');
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(senderId) && String(session.astrologer) !== String(senderId)) {
    throw new AppError('Not a participant', 403);
  }
  if (!message && !mediaUrl && !productId) throw new AppError('Message, image or product required', 400);

  const receiverId = String(session.user) === String(senderId) ? session.astrologer : session.user;

  // Moderate text content (mask phones/links). Images + product cards pass through.
  const { clean, masked, reasons } = filterMessage(message);

  const product = productId ? await resolveSharedProduct(ctx, productId, senderId, session) : undefined;

  const doc = await ChatMessage.create({
    sessionId,
    sender: senderId,
    receiver: receiverId,
    message: clean,
    mediaUrl,
    mediaType,
    product,
  });
  return { message: doc, receiverId, masked, reasons };
}

/** Persist a system/context message for a session (no human sender). Returns
 *  the created doc; the caller decides which side(s) to emit it to. */
async function postSystemMessage(ctx, { sessionId, message, audience = 'both' }) {
  ctx = ctx || defaultContext();
  const ChatMessage = ctx.model('ChatMessage');
  return ChatMessage.create({ sessionId, kind: 'system', audience, message });
}

const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function listMessages(ctx, sessionId, userId, { page = 1, limit = 50 } = {}) {
  ctx = ctx || defaultContext();
  const Session = ctx.model('Session');
  const ChatMessage = ctx.model('ChatMessage');
  const session = await Session.findOne({ sessionId });
  if (!session) throw new AppError('Session not found', 404);
  if (String(session.user) !== String(userId) && String(session.astrologer) !== String(userId)) {
    throw new AppError('Not a participant', 403);
  }
  // 7-day retention: once a completed chat is older than a week its messages
  // have TTL'd out of the DB. Signal `expired` explicitly so the client shows
  // "history no longer available" instead of an ambiguous empty conversation.
  const ref = session.endedAt || session.startedAt || session.createdAt;
  const expired = session.status === 'completed' && ref && (Date.now() - new Date(ref).getTime()) >= CHAT_TTL_MS;
  if (expired) {
    return { items: [], page, limit, expired: true };
  }
  // System messages are audience-scoped: each side only sees the ones meant for
  // it (e.g. the astrologer's context card vs the user's birth-details prompt).
  const side = String(session.user) === String(userId) ? 'user' : 'astrologer';
  const skip = (page - 1) * limit;
  const items = await ChatMessage.find({
    sessionId,
    $or: [
      { kind: 'user' },
      { kind: 'system', audience: { $in: ['both', side] } },
    ],
  })
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit);
  return { items: items.reverse(), page, limit };
}

async function markRead(ctx, sessionId, userId) {
  ctx = ctx || defaultContext();
  const ChatMessage = ctx.model('ChatMessage');
  await ChatMessage.updateMany({ sessionId, receiver: userId, status: { $ne: 'read' } }, { $set: { status: 'read' } });
}

/** Mark a single delivered message; returns the senderId to ack back to. */
async function markDelivered(ctx, messageId, receiverId) {
  ctx = ctx || defaultContext();
  const ChatMessage = ctx.model('ChatMessage');
  const msg = await ChatMessage.findOneAndUpdate(
    { _id: messageId, receiver: receiverId, status: 'sent' },
    { $set: { status: 'delivered' } },
    { new: true }
  );
  return msg ? { senderId: msg.sender, sessionId: msg.sessionId } : null;
}

module.exports = { persist, postSystemMessage, listMessages, markRead, markDelivered };
