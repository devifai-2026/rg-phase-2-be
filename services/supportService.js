const SupportTicket = require('../models/SupportTicket');
const notificationService = require('./notificationService');
const emit = require('../websockets/emit');
const AppError = require('../utils/AppError');

/** User or astrologer submits a help & support ticket. */
async function createTicket({ userId, role, category, subject, description, attachments }) {
  const ticket = await SupportTicket.create({
    user: userId,
    role,
    category,
    subject,
    description,
    attachments: attachments || [],
    messages: [{ sender: userId, fromRole: role, message: description }],
  });
  emit.toAdmins('support-ticket-created', { id: String(ticket._id), subject, category, role });
  // Live admin-console badge + bell.
  emit.adminActivity('support', { id: ticket._id, title: `Support: ${subject || category || 'New ticket'}` });
  return ticket;
}

async function listMine(userId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    SupportTicket.find({ user: userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    SupportTicket.countDocuments({ user: userId }),
  ]);
  return { items, total, page, limit };
}

async function getMine(userId, id) {
  const t = await SupportTicket.findOne({ _id: id, user: userId });
  if (!t) throw new AppError('Ticket not found', 404);
  return t;
}

/** Add a reply (by the ticket owner or, with isAdmin, by support staff). */
async function reply({ ticketId, senderId, fromRole, message, isAdmin = false }) {
  const t = await SupportTicket.findById(ticketId);
  if (!t) throw new AppError('Ticket not found', 404);
  if (!isAdmin && String(t.user) !== String(senderId)) throw new AppError('Not your ticket', 403);

  t.messages.push({ sender: senderId, fromRole, message });
  if (isAdmin && t.status === 'open') t.status = 'in_progress';
  await t.save();

  // Notify the other party.
  if (isAdmin) {
    await notificationService.notify(t.user, {
      type: 'system',
      title: 'Support replied',
      body: `Re: ${t.subject}`,
      data: { ticketId: String(t._id) },
    });
  } else {
    emit.toAdmins('support-ticket-reply', { id: String(t._id), subject: t.subject });
  }
  return t;
}

// ── Admin ──
async function adminList({ status, page = 1, limit = 20 } = {}) {
  const q = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    SupportTicket.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name phone role'),
    SupportTicket.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

async function setStatus({ ticketId, status, adminId }) {
  const t = await SupportTicket.findById(ticketId);
  if (!t) throw new AppError('Ticket not found', 404);
  t.status = status;
  if (status === 'resolved' || status === 'closed') t.resolvedAt = new Date();
  t.assignedTo = adminId;
  await t.save();
  await notificationService.notify(t.user, {
    type: 'system',
    title: 'Support ticket updated',
    body: `Your ticket "${t.subject}" is now ${status}.`,
    data: { ticketId: String(t._id), status },
  });
  return t;
}

module.exports = { createTicket, listMine, getMine, reply, adminList, setStatus };
