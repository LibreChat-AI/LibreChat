const express = require('express');
const { createBannerHandler } = require('@librechat/api');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const { getBanner } = require('~/models');

const router = express.Router();

router.get('/', optionalJwtAuth, createBannerHandler(getBanner));

module.exports = router;
