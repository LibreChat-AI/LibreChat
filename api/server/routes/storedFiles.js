const cookie = require('cookie');
const { FileSources } = require('librechat-data-provider');
const {
  isEnabled,
  s3FileSource,
  azureFileSource,
  getStoredFileURL,
  authenticateViewer,
  createStoredFileHandler,
} = require('@librechat/api');
const { canAccessFile } = require('~/server/middleware/accessResources/fileAccess');
const { findSession, getUserById, getFiles } = require('~/models');

const cookieAuth = {
  parseCookies: cookie.parse,
  isOpenIdReuseEnabled: () => isEnabled(process.env.OPENID_REUSE_TOKENS),
  findSession,
  getUserById,
};

/** The stored file's own access rules, as for `/api/files/download`. */
const canViewFile = async (viewer, { source, key, ownerId }) => {
  const [file] = await getFiles(
    {
      user: ownerId,
      source,
      $or: [{ storageKey: key }, { filepath: getStoredFileURL(source, key) }],
    },
    null,
    { text: 0 },
    1,
  );
  if (!file) {
    return false;
  }
  return canAccessFile({ id: viewer.userId, role: viewer.role, tenantId: viewer.tenantId }, file);
};

module.exports = createStoredFileHandler({
  authenticate: (req) => authenticateViewer(req, cookieAuth),
  sources: { [FileSources.s3]: s3FileSource, [FileSources.azure_blob]: azureFileSource },
  canViewFile,
});
