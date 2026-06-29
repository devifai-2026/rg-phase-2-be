const express = require('express');
const ctrl = require('../controllers/astrologerController');
const reviewCtrl = require('../controllers/reviewController');
const sfDesign = require('../controllers/storefrontDesignController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { astrologerOnly } = require('../middlewares/role');

const router = express.Router();

// Public application (lead) — astrologer accounts are admin-created.
router.post('/apply', validate(v.astrologerSignup), ctrl.submitApplication);

// Login gate: does an astrologer account exist for this phone? (Public.)
// MUST be declared before '/:id' so 'exists' isn't captured as an id.
router.get('/exists/:phone', validate(v.phoneParam, 'params'), ctrl.checkExists);

// Shared expertise catalog (public). Before '/:id' so 'expertise' isn't an id.
router.get('/expertise', ctrl.listExpertise);

// Public discovery.
router.get('/', ctrl.listPublic);
router.get('/:id', ctrl.getPublic);
router.get('/:id/reviews', reviewCtrl.listForAstrologer);

// "Notify me when available" (busy/offline astrologer).
router.post('/:id/notify-me', protect, ctrl.notifyWhenAvailable);
// Which services the current user is already waiting on (restores UI state).
router.get('/:id/notify-me', protect, ctrl.myNotifyRequests);
// Follow / unfollow + the current user's follow state (restores button on open).
router.post('/:id/follow', protect, ctrl.toggleFollow);
router.get('/:id/follow', protect, ctrl.myFollow);

// Astrologer self-service.
router.get('/me/profile', protect, astrologerOnly, ctrl.myProfile);
router.put('/me/profile', protect, astrologerOnly, validate(v.astrologerSelfUpdate), ctrl.updateMyProfile);
router.get('/me/stats', protect, astrologerOnly, ctrl.myStats);
router.get('/me/followers', protect, astrologerOnly, ctrl.myFollowers);
// Self-service payout (bank / UPI) details — saved instantly, admin notified.
router.get('/me/payout-details', protect, astrologerOnly, ctrl.getPayoutDetails);
router.put('/me/payout-details', protect, astrologerOnly, validate(v.payoutDetails), ctrl.savePayoutDetails);
router.post('/me/online', protect, astrologerOnly, validate(v.onlineToggle), ctrl.setOnline);

// ── Storefront: theme + astrologer-owned products/poojas (self-service) ──
const store = require('../controllers/storeController');
router.put('/me/store-theme', protect, astrologerOnly, store.setStoreTheme);

// "Let the Stars design your storefront" — AI storefront layouts (3 lifetime).
router.get('/me/storefront-design/usage', protect, astrologerOnly, sfDesign.usage);
router.get('/me/storefront-design', protect, astrologerOnly, sfDesign.list);
router.post('/me/storefront-design/generate', protect, astrologerOnly, sfDesign.generate);
router.put('/me/storefront-design/active', protect, astrologerOnly, sfDesign.setActive);
router.get('/me/products', protect, astrologerOnly, store.myProducts);
// Shareable catalogue (storefront + RudraMaal) for the in-chat product picker.
router.get('/me/catalogue', protect, astrologerOnly, store.shareableCatalogue);
router.post('/me/products', protect, astrologerOnly, store.createProduct);
router.put('/me/products/:id', protect, astrologerOnly, store.updateProduct);
router.delete('/me/products/:id', protect, astrologerOnly, store.deleteProduct);
router.get('/me/poojas', protect, astrologerOnly, store.myPoojas);
router.post('/me/poojas', protect, astrologerOnly, store.createPooja);
router.put('/me/poojas/:id', protect, astrologerOnly, store.updatePooja);
router.delete('/me/poojas/:id', protect, astrologerOnly, store.deletePooja);
// Storefront orders + pooja bookings (read-only; astrologer can flag "sent to admin").
router.get('/me/store-orders', protect, astrologerOnly, store.myStoreOrders);
router.post('/me/store-orders/:id/sent', protect, astrologerOnly, store.markOrderSentToAdmin);
router.get('/me/pooja-bookings', protect, astrologerOnly, store.myPoojaBookings);
// Public storefront (no auth) — only approved/live items.
router.get('/:id/storefront', store.publicStorefront);

module.exports = router;
