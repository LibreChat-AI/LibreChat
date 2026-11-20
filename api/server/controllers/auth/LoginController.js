const { createLoginController, clearCloudFrontCookies } = require('@librechat/api');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { getUserById, deleteAllUserSessions } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');

const loginController = createLoginController({
  generate2FATempToken,
  getUserById,
  deleteAllUserSessions,
  setAuthTokens,
  clearCloudFrontCookies,
});

module.exports = { loginController };
