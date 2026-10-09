const { isOboConfigStillTrusted } = require('@librechat/api');
const db = require('~/models');

/**
 * Checks whether a parsed MCP server config is DB-sourced (user-created) using
 * the same `isUserSourced` heuristics as the rest of the MCP layer: an explicit
 * `source` is authoritative when present; otherwise `dbId` presence is used.
 */
function isDbSourced({ source, dbId }) {
  if (source != null) {
    return source === 'user';
  }
  return !!dbId;
}

/**
 * Builds the predicate the MCP runtime calls before performing an OBO token exchange.
 *
 * YAML/Config-sourced configs (admin-defined) bypass the check — admins are
 * already trusted at the deployment level. DB-sourced configs (created via the
 * UI) are gated on the original author still holding `MCP_SERVERS.CONFIGURE_OBO`,
 * so retained configs fail closed when an author's role is downgraded.
 */
function createOboTrustChecker() {
  return async ({ source, author, dbId }) => {
    if (!isDbSourced({ source, dbId })) {
      return true;
    }
    return isOboConfigStillTrusted({
      authorId: author,
      getUserRoleByAuthorId: async (userId) => {
        const user = await db.findUser({ _id: userId }, 'role');
        return user?.role;
      },
      getRolePermissions: async (roleName) => {
        const role = await db.getRoleByName(roleName);
        return role?.permissions;
      },
    });
  };
}

module.exports = { createOboTrustChecker };
