const axios = require('axios');
const {
  isEnabled,
  generateShortLivedToken,
  logAxiosError,
  createRagContextHandlers,
} = require('@librechat/api');

function createContextHandlers(req, userMessageContent) {
  return createRagContextHandlers({
    req,
    userMessageContent,
    ragApiUrl: process.env.RAG_API_URL,
    fullContextSetting: process.env.RAG_USE_FULL_CONTEXT,
    httpClient: axios,
    isEnabled,
    generateShortLivedToken,
    logAxiosError,
  });
}

module.exports = createContextHandlers;
