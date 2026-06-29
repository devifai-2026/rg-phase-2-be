const express = require('express');
const appConfig = require('../controllers/appConfigController');

const router = express.Router();

// Public: the app fetches banners + videos/lessons + section toggles on launch.
router.get('/', appConfig.publicConfig);

module.exports = router;
