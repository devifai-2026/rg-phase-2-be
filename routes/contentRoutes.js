const express = require('express');
const ctrl = require('../controllers/contentController');

const router = express.Router();

// Public CMS reads (Contact Us, About, Terms, Privacy, FAQ...).
router.get('/', ctrl.list);
// Paginated + searchable videos/lessons ("See all"). MUST precede '/:key'.
router.get('/videos', ctrl.listVideosPublic);
router.get('/:key', ctrl.get);

module.exports = router;
