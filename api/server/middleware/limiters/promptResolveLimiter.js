const { createPromptResolveLimiter } = require('@librechat/api');

const promptResolveLimiter = createPromptResolveLimiter();

module.exports = { promptResolveLimiter };
