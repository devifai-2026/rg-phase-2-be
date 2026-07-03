const { defaultContext } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');

/** Public: create a contact-us enquiry from the landing page. */
async function create(ctx, { name, email, phone, subject, message, anonId, source, ip, userAgent }) {
  ctx = ctx || defaultContext();
  const Enquiry = ctx.model('Enquiry');
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
async function list(ctx, { page = 1, limit = 20, status } = {}) {
  ctx = ctx || defaultContext();
  const Enquiry = ctx.model('Enquiry');
  const q = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [items, total, newCount] = await Promise.all([
    Enquiry.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('handledBy', 'name').lean(),
    Enquiry.countDocuments(q),
    Enquiry.countDocuments({ status: 'new' }),
  ]);
  return { items, total, page, limit, newCount };
}

async function getOne(ctx, id) {
  ctx = ctx || defaultContext();
  const Enquiry = ctx.model('Enquiry');
  const doc = await Enquiry.findById(id).populate('handledBy', 'name').lean();
  if (!doc) throw new AppError('Enquiry not found', 404);
  return doc;
}

/** Admin: update status / note. */
async function update(ctx, id, { status, adminNote }, actorId) {
  ctx = ctx || defaultContext();
  const Enquiry = ctx.model('Enquiry');
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
