const Enquiry = require('../models/Enquiry');
const AppError = require('../utils/AppError');

/** Public: create a contact-us enquiry from the landing page. */
async function create({ name, email, phone, subject, message, anonId, source, ip, userAgent }) {
  const doc = await Enquiry.create({
    name,
    email: email || '',
    phone: phone || '',
    subject: subject || '',
    message,
    anonId: anonId || '',
    source: source || 'landing',
    ip: ip || '',
    userAgent: userAgent || '',
  });
  // Live admin-console badge + bell.
  require('../websockets/emit').adminActivity('enquiry', { id: doc._id, title: `Enquiry: ${subject || name || 'New enquiry'}` });
  return { id: doc._id };
}

/** Admin: paginated list with optional status filter. */
async function list({ page = 1, limit = 20, status } = {}) {
  const q = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [items, total, newCount] = await Promise.all([
    Enquiry.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('handledBy', 'name').lean(),
    Enquiry.countDocuments(q),
    Enquiry.countDocuments({ status: 'new' }),
  ]);
  return { items, total, page, limit, newCount };
}

async function getOne(id) {
  const doc = await Enquiry.findById(id).populate('handledBy', 'name').lean();
  if (!doc) throw new AppError('Enquiry not found', 404);
  return doc;
}

/** Admin: update status / note. */
async function update(id, { status, adminNote }, actorId) {
  const doc = await Enquiry.findById(id);
  if (!doc) throw new AppError('Enquiry not found', 404);
  if (status) {
    doc.status = status;
    if (status === 'resolved') doc.resolvedAt = new Date();
  }
  if (typeof adminNote === 'string') doc.adminNote = adminNote;
  doc.handledBy = actorId;
  await doc.save();
  return doc;
}

module.exports = { create, list, getOne, update };
