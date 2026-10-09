const mongoose = require('mongoose');
const { createSharedLinkAccessMiddleware } = require('@librechat/api');

const canAccessSharedLink = createSharedLinkAccessMiddleware({ mongoose });

module.exports = canAccessSharedLink;
