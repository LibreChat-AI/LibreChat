const {
  getRetentionExpiry: getRetentionExpiryWithDeps,
  getAgentFileRetentionExpiry: getAgentFileRetentionExpiryWithDeps,
} = require('@librechat/api');
const { logger, createChatExpirationDate } = require('@librechat/data-schemas');
const db = require('~/models');

const getRetentionDependencies = () => ({
  getConvo: db.getConvoRetention ?? db.getConvo,
  createExpirationDate: createChatExpirationDate,
  logger,
});

/** Event-bound actors inherit the binding's server-authenticated deadline. Never
 * extend files beyond the child conversation that makes them addressable. */
function getEventBindingRetention(req) {
  const retention = req?._agentEventBindingRetention;
  if (retention?.expiredAt == null) {
    return null;
  }
  const expiredAt =
    retention.expiredAt instanceof Date ? retention.expiredAt : new Date(retention.expiredAt);
  return Number.isNaN(expiredAt.getTime()) ? null : { expiredAt };
}

/**
 * Returns `{ expiredAt }` when the request indicates data retention applies, otherwise `{}`.
 * Spread into file data objects before calling createFile.
 * @param {ServerRequest} req
 * @returns {Promise<{ expiredAt?: Date | null }>}
 */
async function getRetentionExpiry(req) {
  const inherited = getEventBindingRetention(req);
  if (inherited != null) {
    return inherited;
  }
  return getRetentionExpiryWithDeps(req, getRetentionDependencies());
}

/**
 * Returns `{ expiredAt }` for agent file uploads when retention applies, otherwise `{}`.
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {boolean} [params.messageAttachment]
 * @param {string} [params.tool_resource]
 * @param {string} [params.toolResource]
 * @returns {Promise<{ expiredAt?: Date | null }>}
 */
async function getAgentFileRetentionExpiry({ tool_resource, toolResource, ...params }) {
  const inherited = getEventBindingRetention(params.req);
  if (inherited != null) {
    return inherited;
  }
  return getAgentFileRetentionExpiryWithDeps(
    { ...params, toolResource: tool_resource ?? toolResource },
    getRetentionDependencies(),
  );
}

module.exports = {
  getRetentionExpiry,
  getAgentFileRetentionExpiry,
};
