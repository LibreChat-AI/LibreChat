const {
  SAFE_CONVERSATION_TITLE,
  resolveConversationTitle: resolveTitlePolicy,
} = require('@librechat/api');

/**
 * @param {ServerRequest} req
 * @param {unknown} candidate
 * @param {string} [fallback]
 * @returns {string|null}
 */
function resolveConversationTitle(req, candidate, fallback = SAFE_CONVERSATION_TITLE) {
  return resolveTitlePolicy({ filters: req?.config?.filters, candidate, fallback });
}

module.exports = {
  SAFE_CONVERSATION_TITLE,
  resolveConversationTitle,
};
