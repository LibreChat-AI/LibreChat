const { createBalanceHandlers } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const {
  findBalanceByUser,
  findPendingBalanceRequestByUser,
  createBalanceRequest,
} = require('~/models');

const handlers = createBalanceHandlers({
  findBalanceByUser,
  findPendingBalanceRequestByUser,
  createBalanceRequest,
  getAppConfig,
});

module.exports = handlers;
