const express = require('express');
const router = express.Router();
const controller = require('../controllers/CropController.js');

router.get('/', controller);
module.exports = router;
