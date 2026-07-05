const express = require('express');
const ctrl = require('../controllers/doshaController');
const { protect } = require('../middlewares/auth');

const router = express.Router();
router.post('/manglik', protect, ctrl.manglik); // instant Manglik dosha (both apps)
module.exports = router;
