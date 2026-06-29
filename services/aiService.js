const AiConversation = require('../models/AiConversation');
const AiMessage = require('../models/AiMessage');
const User = require('../models/User');
const vedicAstroService = require('./vedicAstroService');
const llmService = require('./llmService');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../utils/logger');

async function buildSystemPrompt(user) {
  let ascendant = 'unknown';
  let moonSign = 'unknown';
  if (user.birthDetails && user.birthDetails.dob) {
    try {
      const chart = await vedicAstroService.getChart({
        dob: user.birthDetails.dob,
        tob: user.birthDetails.time,
        lat: user.birthDetails.lat,
        lon: user.birthDetails.lng,
        tz: user.birthDetails.tz,
      });
      ascendant = chart.ascendant || ascendant;
      moonSign = chart.moonSign || moonSign;
    } catch (e) {
      logger.debug('chart fetch for AI failed', e.message);
    }
  }
  return (
    `You are an expert Vedic astrologer and wellness guide. Be warm, concise, and practical. ` +
    `The seeker's birth ascendant (Lagna) is ${ascendant} and Moon sign (Rashi) is ${moonSign}. ` +
    `Tailor guidance to these where relevant. Offer remedies that are safe and non-judgmental. ` +
    `Never give medical, legal, or financial guarantees; suggest consulting a professional for those. ` +
    `If birth details are unknown, ask for date, time, and place of birth.`
  );
}

async function chat({ userId, conversationId, message }) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);

  let conversation;
  if (conversationId) {
    conversation = await AiConversation.findOne({ _id: conversationId, user: userId });
    if (!conversation) throw new AppError('Conversation not found', 404);
  } else {
    conversation = await AiConversation.create({ user: userId, title: message.slice(0, 40) });
  }

  await AiMessage.create({ conversation: conversation._id, role: 'user', content: message });

  const history = await AiMessage.find({ conversation: conversation._id })
    .sort({ createdAt: -1 })
    .limit(env.llm.maxHistoryTurns)
    .then((m) => m.reverse());

  const system = await buildSystemPrompt(user);

  let answer;
  if (!llmService.available()) {
    answer =
      `(AI astrologer — demo mode) Thank you for your question: "${message}". ` +
      `Based on your chart, focus on patience and grounded routines this week. ` +
      `Configure the Gemini/Vertex provider for full readings.`;
  } else {
    try {
      answer = await llmService.complete({
        system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: env.llm.maxTokens,
        temperature: 0.8,
      });
    } catch (e) {
      logger.warn('AI chat LLM failed; returning graceful message', e.message);
      answer = 'I could not generate a reading just now. Please try again in a moment.';
    }
  }

  const assistantMsg = await AiMessage.create({ conversation: conversation._id, role: 'assistant', content: answer });
  await AiConversation.updateOne({ _id: conversation._id }, { $set: { lastMessageAt: new Date() } });

  return { conversationId: conversation._id, reply: answer, messageId: assistantMsg._id };
}

async function listConversations(userId) {
  return AiConversation.find({ user: userId }).sort({ lastMessageAt: -1 }).limit(50);
}

async function getConversation(userId, conversationId) {
  const conv = await AiConversation.findOne({ _id: conversationId, user: userId });
  if (!conv) throw new AppError('Conversation not found', 404);
  const messages = await AiMessage.find({ conversation: conversationId }).sort({ createdAt: 1 });
  return { conversation: conv, messages };
}

module.exports = { chat, listConversations, getConversation };
