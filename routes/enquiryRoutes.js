const express = require('express');
const ctrl = require('../controllers/enquiryController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { enquiryLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

// Public contact-us submission from the landing page.
router.post('/', enquiryLimiter, validate(v.enquiry), ctrl.create);

module.exports = router;
