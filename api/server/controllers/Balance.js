const { findBalanceByUser } = require('~/models');
const { createBalanceController } = require('@librechat/api');

module.exports = createBalanceController({ findBalanceByUser });
