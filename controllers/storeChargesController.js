const asyncHandler = require('../utils/asyncHandler');

/** The singleton charges doc (created with safe defaults on first access). */
/**
 * The singleton store-charges doc for a tenant, created on first read.
 *
 * `StoreCharges` MUST be the tenant-bound model (`req.model('StoreCharges')`).
 * A caller that forgot it used to blow up with the opaque "Cannot read
 * properties of undefined (reading 'findOne')" — which is exactly how every
 * wallet checkout started 500ing. Name the real problem instead.
 */
async function getOrCreate(StoreCharges) {
  if (!StoreCharges) {
    throw new Error('storeCharges.getOrCreate: pass the tenant-bound model, e.g. req.model(\'StoreCharges\')');
  }
  let doc = await StoreCharges.findOne({ key: 'store' });
  if (!doc) doc = await StoreCharges.create({ key: 'store' });
  return doc;
}

/** GET /store-charges — public; the app uses this to render the bill. */
exports.get = asyncHandler(async (req, res) => {
  const StoreCharges = req.model('StoreCharges');
  const doc = await getOrCreate(StoreCharges);
  res.json({ success: true, data: doc });
});

/** PUT /admin/store-charges — admin updates the toggles/values. */
exports.update = asyncHandler(async (req, res) => {
  const StoreCharges = req.model('StoreCharges');
  const doc = await getOrCreate(StoreCharges);
  const { delivery, gst, shipping, platform, freeDeliveryAbove } = req.body;
  // Merge each charge block (keep label defaults).
  const merge = (cur, next) => {
    if (!next) return cur;
    return {
      label: next.label != null ? String(next.label) : cur.label,
      enabled: next.enabled != null ? !!next.enabled : cur.enabled,
      type: ['flat', 'percent'].includes(next.type) ? next.type : cur.type,
      value: next.value != null ? Math.max(0, Number(next.value) || 0) : cur.value,
    };
  };
  doc.delivery = merge(doc.delivery, delivery);
  doc.gst = merge(doc.gst, gst);
  doc.shipping = merge(doc.shipping, shipping);
  doc.platform = merge(doc.platform, platform);
  if (freeDeliveryAbove != null) doc.freeDeliveryAbove = Math.max(0, Number(freeDeliveryAbove) || 0);
  await doc.save();
  res.json({ success: true, data: doc });
});

exports.getOrCreate = getOrCreate;
