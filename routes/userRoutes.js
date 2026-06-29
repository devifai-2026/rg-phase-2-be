const express = require('express');
const ctrl = require('../controllers/userController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');
const { upload } = require('../middlewares/upload');

const router = express.Router();

// Profile photo + generic image upload (multipart field: "image"), hosted on ImageBB.
router.post('/avatar', protect, upload.single('image'), ctrl.uploadAvatar);
router.post('/upload', protect, upload.single('image'), ctrl.uploadImage);

// Address book (multiple, e-commerce style).
router.get('/addresses', protect, ctrl.listAddresses);
router.post('/addresses', protect, validate(v.address), ctrl.addAddress);
router.put('/addresses/:addressId', protect, validate(v.address), ctrl.updateAddress);
router.delete('/addresses/:addressId', protect, ctrl.deleteAddress);
router.patch('/addresses/:addressId/default', protect, ctrl.setDefaultAddress);

// Referral
router.get('/referral', protect, ctrl.referral);
router.post('/referral/apply', protect, ctrl.applyReferral);

module.exports = router;
