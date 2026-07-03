const { defaultContext } = require('../utils/tenantContext');
const logger = require('../utils/logger');

/** Fire-and-forget audit record for privileged actions. */
async function log(ctx, { actor, action, targetType, target, summary, meta, ip }) {
  ctx = ctx || defaultContext();
  const AuditLog = ctx.model('AuditLog');
  try {
    await AuditLog.create({
      actor: actor._id,
      actorRole: actor.role,
      action,
      targetType,
      target,
      summary,
      meta,
      ip,
    });
  } catch (e) {
    logger.debug('audit log failed', e.message);
  }
}

async function list(ctx, { page = 1, limit = 30, action, scope = 'users' } = {}) {
  ctx = ctx || defaultContext();
  const AuditLog = ctx.model('AuditLog');
  const q = action ? { action } : {};
  // 'users' (default): the audit trail is about APP USERS — drop pure platform/
  // admin-housekeeping rows (creating admins, editing settings, audit of admins)
  // so the view only shows actions that affect app users. 'all' keeps everything.
  if (scope === 'users') {
    q.targetType = { $nin: ['admin', 'settings'] };
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    AuditLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('actor', 'name phone role'),
    AuditLog.countDocuments(q),
  ]);
  return { items, total, page, limit };
}

module.exports = { log, list };
