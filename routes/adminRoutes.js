const express = require('express');
const admin = require('../controllers/adminController');
const astrologerCtrl = require('../controllers/astrologerController');
const orderCtrl = require('../controllers/orderController');
const giftCtrl = require('../controllers/giftController');
const categoryCtrl = require('../controllers/categoryController');
const productCtrl = require('../controllers/productController');
const enquiryCtrl = require('../controllers/enquiryController');
const reviewCtrl = require('../controllers/reviewController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { adminOnly, superAdminOnly } = require('../middlewares/role');

const router = express.Router();

// All admin routes require an authenticated admin or super_admin.
router.use(protect, adminOnly);

// ── Dashboard & inventory alerts ──
router.get('/dashboard', admin.dashboard);
router.get('/low-stock', admin.lowStock);
router.get('/leaderboard', admin.leaderboard);

// ── Astrologer management (CRUD) ──
router.get('/astrologers', admin.listAstrologers);
// Verify an astrologer's phone via OTP (dev 123456) before create / phone change.
// Declared before '/astrologers/:id' so 'request-otp' isn't captured as an id.
router.post('/astrologers/request-otp', validate(v.adminAstrologerOtp), astrologerCtrl.adminRequestAstrologerOtp);
router.post('/astrologers', validate(v.astrologerAdminUpdate), astrologerCtrl.adminCreate);
router.get('/astrologers/:id/full', admin.astrologerFull);
router.get('/astrologers/:id/call-logs', admin.callLogs);
router.get('/astrologers/:id', astrologerCtrl.adminDetail);
router.put('/astrologers/:id', validate(v.astrologerAdminUpdate), admin.updateAstrologer);
router.delete('/astrologers/:id', astrologerCtrl.adminDelete);
// Permanently delete a non-active application (lead).
router.delete('/astrologers/:id/application', astrologerCtrl.adminDeleteApplication);

// Admin-authored reviews (fake-name testimonials) + removal. :id = AstrologerProfile.
router.post('/astrologers/:id/reviews', validate(v.adminReview), reviewCtrl.adminCreateReview);
router.delete('/reviews/:reviewId', reviewCtrl.adminDeleteReview);

// ── Transactions (wallet ledger across all users) ──
router.get('/transactions', admin.listTransactions);
router.get('/transactions/summary', admin.transactionsSummary);

// ── Users + manual wallet recharge ──
router.get('/users', admin.listUsers);
// Admin adds a user with OTP verification (dummy 123456 in dev).
router.post('/users/request-otp', validate(v.adminUserOtp), admin.requestUserOtp);
router.post('/users', validate(v.adminCreateUser), admin.createUser);
router.post('/users/recharge', validate(v.adminRecharge), admin.rechargeUser);
router.get('/users/:id', admin.userDetail);
router.patch('/users/:id/block', admin.blockUser);
router.delete('/users/:id', admin.deleteUser);

// ── E-commerce: categories + products + inventory ──
router.post('/categories', validate(v.category), categoryCtrl.create);
router.put('/categories/:id', validate(v.category), categoryCtrl.update);
router.delete('/categories/:id', categoryCtrl.remove);
router.post('/products', validate(v.product), productCtrl.create);
router.put('/products/:id', productCtrl.update);
router.delete('/products/:id', productCtrl.remove);

// Astrologer storefront submissions — review + approve/reject (set commission).
const storeCtrl = require('../controllers/storeController');
router.get('/store/submissions', storeCtrl.adminListSubmissions);
router.patch('/store/:kind/:id/approve', storeCtrl.adminApprove);
router.patch('/store/:kind/:id/reject', storeCtrl.adminReject);
router.patch('/store/:kind/:id', storeCtrl.adminEdit);

// Store-wide charges (delivery / GST / shipping / platform).
router.put('/store-charges', require('../controllers/storeChargesController').update);

// Feedback + app ratings (read/triage).
const feedbackCtrl = require('../controllers/feedbackController');
router.get('/feedback', feedbackCtrl.adminListFeedback);
router.patch('/feedback/:id', feedbackCtrl.adminUpdateFeedback);
router.get('/app-ratings', feedbackCtrl.adminListRatings);

// ── Orders (manual fulfillment) + invoices ──
router.get('/orders', orderCtrl.adminList);
router.get('/orders-analytics', orderCtrl.adminAnalytics);
router.patch('/orders/:id/status', validate(v.orderStatus), orderCtrl.updateStatus);
router.get('/orders/:id/invoice', orderCtrl.getInvoice);

// ── Order support ("Need help" requests) ──
router.get('/order-support', orderCtrl.adminListSupport);
router.patch('/order-support/:id/status', validate(v.orderSupportStatus), orderCtrl.adminSetSupportStatus);

// ── Recharge templates (app "Add money" packs) ──
router.get('/recharge-templates', admin.listRechargeTemplates);
router.post('/recharge-templates', validate(v.rechargeTemplate), admin.createRechargeTemplate);
router.put('/recharge-templates/:id', validate(v.rechargeTemplate), admin.updateRechargeTemplate);
router.delete('/recharge-templates/:id', admin.deleteRechargeTemplate);

// ── Pooja: categories + catalog + bookings ──
router.get('/pooja-categories', admin.listPoojaCategories);
router.post('/pooja-categories', admin.createPoojaCategory);
router.put('/pooja-categories/:id', admin.updatePoojaCategory);
router.delete('/pooja-categories/:id', admin.deletePoojaCategory);
router.get('/pooja-types', admin.listPoojaTypes);
router.post('/pooja-types', admin.createPoojaType);
router.put('/pooja-types/:id', admin.updatePoojaType);
router.delete('/pooja-types/:id', admin.deletePoojaType);

// ── Invoices: templates + generated invoices ──
// ── Payment gateway config (changing it requires an OTP to the admin's phone) ──
router.get('/payment-gateway', admin.getPaymentGateway);
router.post('/payment-gateway/request-otp', admin.requestPaymentGatewayOtp);
router.put('/payment-gateway', admin.updatePaymentGateway);

// ── Firebase / GA4 analytics (native admin charts via GA4 Data API) ──
router.get('/analytics/ga', admin.gaAnalytics);

// ── Agora credentials (secret encrypted; save + reveal are OTP-gated) ──
router.get('/agora', admin.getAgoraConfig);
router.post('/agora/request-otp', admin.requestAgoraOtp);
router.put('/agora', admin.updateAgoraConfig);
router.post('/agora/reveal', admin.revealAgoraSecret);
// Live channel diagnostics (broadcaster/audience) — debug audio/video transfer.
router.get('/agora/channel/:sessionId', admin.agoraChannelDiagnostics);

// ── Danger Prompts (LLM SYSTEM prompts) — super-admin only, OTP-gated edits ──
router.get('/prompts', superAdminOnly, admin.listPrompts);
router.post('/prompts/request-otp', superAdminOnly, admin.requestPromptOtp);
router.put('/prompts', superAdminOnly, admin.updatePrompt);

// ── VedicAstroAPI credentials (key encrypted; save + reveal are OTP-gated) ──
router.get('/vedic-astro', admin.getVedicAstroConfig);
router.post('/vedic-astro/request-otp', admin.requestVedicAstroOtp);
router.put('/vedic-astro', admin.updateVedicAstroConfig);
router.post('/vedic-astro/reveal', admin.revealVedicAstroSecret);

router.get('/invoice-templates', admin.listInvoiceTemplates);
router.get('/invoice-templates/preview', admin.previewInvoiceTemplate); // sample PDF
router.post('/invoice-templates/preview', admin.previewInvoiceTemplate);
router.post('/invoice-templates', admin.createInvoiceTemplate);
router.put('/invoice-templates/:id', admin.updateInvoiceTemplate);
router.delete('/invoice-templates/:id', admin.deleteInvoiceTemplate);
router.get('/invoices', admin.listInvoices);
router.post('/invoices/:id/regenerate', admin.regenerateInvoicePdf);
router.get('/pooja-bookings', admin.listPoojaBookings);
router.patch('/pooja-bookings/:id', admin.updatePoojaBooking);

// ── AI personas (AI astrologer cards) ──
router.get('/ai-personas', admin.listPersonas);
router.post('/ai-personas', admin.createPersona);
router.put('/ai-personas/:id', admin.updatePersona);
router.delete('/ai-personas/:id', admin.deletePersona);

// ── Offers: coupons + bundles ──
const offers = require('../controllers/offersController');
router.get('/coupons', offers.listCoupons);
router.post('/coupons', offers.createCoupon);
router.put('/coupons/:id', offers.updateCoupon);
router.delete('/coupons/:id', offers.deleteCoupon);
router.get('/bundles', offers.listBundles);
router.post('/bundles', offers.createBundle);
router.put('/bundles/:id', offers.updateBundle);
router.delete('/bundles/:id', offers.deleteBundle);

// ── Monitors: live chats, active calls, call logs, read a chat thread ──
router.get('/monitor/chats', admin.liveChats);
router.get('/monitor/calls', admin.activeCalls);
router.get('/monitor/call-logs', admin.callLogs);
// Chat history + analytics (filters: user, astrologer, q, from, to).
router.get('/monitor/chat-logs', admin.chatLogs);
router.get('/monitor/chat-analytics', admin.chatAnalytics);
router.get('/monitor/sessions/:sessionId/messages', admin.sessionMessages);

// ── Storefront designs: view + switch an astrologer's AI-generated layouts ──
// :id = astrologer USER id.
router.get('/astrologers/:id/storefront-layouts', admin.listStorefrontLayouts);
router.put('/astrologers/:id/storefront-layouts/active', admin.setStorefrontLayout);

// ── Admin Feedback: astrologer-authored post-service / post-live feedback ──
// (filters: serviceType, kind, astrologerId, minRating, from, to + pagination).
router.get('/service-feedback', admin.listServiceFeedback);

// ── AI: scheduled reminders + chat recaps + LLM call logs + notifications ──
router.get('/ai/reminders', admin.listReminders);
router.get('/ai/recaps', admin.listRecaps);
router.get('/ai/logs', admin.listAiLogs);            // LLM Logs tab
router.get('/ai/notifications', admin.listAiNotifications); // AI Notifications tab

// ── Translation (GCP) — run a full pass + status, super-admin ──
router.get('/translation/status', superAdminOnly, admin.translationStatus);
router.get('/translation/runs', superAdminOnly, admin.translationRuns);
router.post('/translation/run', superAdminOnly, admin.runTranslation);

// ── AI Marketing Agent (engagement push generator + scheduler) — super-admin ──
router.get('/marketing/config', superAdminOnly, admin.getMarketingConfig);
router.put('/marketing/config', superAdminOnly, admin.updateMarketingConfig);
router.post('/marketing/generate', superAdminOnly, admin.generateMarketing);
router.post('/marketing/review', superAdminOnly, admin.reviewMarketing);
router.get('/marketing', superAdminOnly, admin.listMarketing);
router.post('/marketing/run-now', superAdminOnly, admin.runMarketingNow);

// ── Withdrawals (process payout) ──
router.get('/withdrawals', admin.listWithdrawals);
router.patch('/withdrawals/:id/approve', admin.approveWithdrawal);
router.patch('/withdrawals/:id/reject', admin.rejectWithdrawal);

// ── Escalations ──
router.get('/escalations', admin.listEscalations);
router.patch('/escalations/:id/resolve', admin.resolveEscalation);

// ── Support tickets ──
router.get('/support/tickets', admin.listTickets);
router.post('/support/tickets/:id/reply', validate(v.supportReply), admin.replyTicket);
router.patch('/support/tickets/:id/status', validate(v.supportStatus), admin.setTicketStatus);

// ── Gift CRUD ──
router.post('/gifts', validate(v.gift), giftCtrl.create);
router.put('/gifts/:id', giftCtrl.update);
router.delete('/gifts/:id', giftCtrl.remove);

// ── Site content (Contact Us / About / Terms / FAQ ...) ──
router.get('/content', admin.contentList);
router.put('/content/:key', validate(v.siteContent), admin.contentUpsert);

// ── Enquiries (contact-us submissions from the landing page) ──
router.get('/enquiries', enquiryCtrl.list);
router.get('/enquiries/:id', enquiryCtrl.getOne);
router.patch('/enquiries/:id', validate(v.enquiryUpdate), enquiryCtrl.update);

// ─────────────────────────────────────────────────────────────
// SUPER ADMIN ONLY — platform settings, admin management, audit
// ─────────────────────────────────────────────────────────────
router.get('/settings', superAdminOnly, admin.getSettings);
router.put('/settings', superAdminOnly, admin.updateSettings);

router.get('/admins', superAdminOnly, admin.listAdmins);
// Verify the new admin's phone via OTP (dev 123456) before creating. Reuses the
// user OTP request — both just send a code to a must-be-free number.
router.post('/admins/request-otp', superAdminOnly, validate(v.adminUserOtp), admin.requestUserOtp);
router.post('/admins', superAdminOnly, validate(v.createAdmin), admin.createAdmin);
router.delete('/admins/:id', superAdminOnly, admin.deleteAdmin);

router.get('/audit-logs', superAdminOnly, admin.auditLogs);

// ── App Configuration: promo banners, Home videos/lessons, section toggles ──
const appConfig = require('../controllers/appConfigController');
router.get('/app-config', superAdminOnly, appConfig.getConfig);
router.put('/app-config', superAdminOnly, appConfig.updateConfig);

router.get('/banners', superAdminOnly, appConfig.listBanners);
router.post('/banners', superAdminOnly, appConfig.createBanner);
// Reorder must precede '/banners/:id' so 'reorder' isn't matched as an :id.
router.put('/banners/reorder', superAdminOnly, appConfig.reorderBanners);
router.put('/banners/:id', superAdminOnly, appConfig.updateBanner);
router.delete('/banners/:id', superAdminOnly, appConfig.deleteBanner);

router.get('/videos', superAdminOnly, appConfig.listVideos);
router.post('/videos', superAdminOnly, appConfig.createVideo);
router.put('/videos/:id', superAdminOnly, appConfig.updateVideo);
router.delete('/videos/:id', superAdminOnly, appConfig.deleteVideo);

module.exports = router;
