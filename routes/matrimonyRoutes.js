const express = require('express');
const ctrl = require('../controllers/matrimonyController');
const validate = require('../middlewares/validate');
const v = require('../utils/validators');
const { protect } = require('../middlewares/auth');

const router = express.Router();

router.get('/search', protect, ctrl.search);
router.post('/match', protect, validate(v.kundliMatch), ctrl.match);

router.post('/profiles', protect, validate(v.matrimonyProfile), ctrl.create);
router.get('/profiles', protect, ctrl.listMine);
router.get('/profiles/:id', protect, ctrl.get);
router.put('/profiles/:id', protect, ctrl.update);
router.delete('/profiles/:id', protect, ctrl.remove);

module.exports = router;
