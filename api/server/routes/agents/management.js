const express = require('express');
const fs = require('fs').promises;
const {
  EModelEndpoint,
  EToolResources,
  AgentCapabilities,
  getEndpointFileConfig,
  mergeFileConfig,
  resolveEndpointType,
} = require('librechat-data-provider');
const {
  createAgentUploadLock,
  createAgentManagementCreateHandler,
  createAgentManagementDeleteHandler,
  createAgentManagementFileHandlers,
  createAgentManagementUploadResponse,
  createAgentManagementReadHandlers,
  createAgentManagementUpdateHandler,
  ioredisClient,
  mapAgentManagementError,
  restoreTenantContextFromReq,
  resolveToolRoleGrants,
} = require('@librechat/api');
const { checkBan, configMiddleware, createFileLimiters } = require('~/server/middleware');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { checkPermission, findAccessibleResources } = require('~/server/services/PermissionService');
const { createMulterInstance } = require('~/server/routes/files/multer');
const { handleFileUpload } = require('~/server/routes/files/files');
const { checkCapability, getEndpointsConfig } = require('~/server/services/Config');
const v1 = require('~/server/controllers/agents/v1');
const db = require('~/models');
const { requireAgentManagementAuth } = require('./middleware');

const router = express.Router();
const readHandlers = createAgentManagementReadHandlers({
  getRoleByName: db.getRoleByName,
  getAgentWithVersionCount: db.getAgentWithVersionCount,
  getAgentManagementListByAccess: db.getAgentManagementListByAccess,
  findAccessibleResources,
  checkPermission,
  hasCapability,
});
const createHandler = createAgentManagementCreateHandler({
  getRoleByName: db.getRoleByName,
  createAgent: v1.createAgent,
});
const updateHandler = createAgentManagementUpdateHandler({
  getRoleByName: db.getRoleByName,
  getAgentWithVersionCount: db.getAgentWithVersionCount,
  checkPermission,
  hasCapability,
  updateAgent: v1.updateAgent,
});
const deleteHandler = createAgentManagementDeleteHandler({
  getRoleByName: db.getRoleByName,
  getAgentWithVersionCount: db.getAgentWithVersionCount,
  checkPermission,
  hasCapability,
  deleteAgent: db.deleteAgent,
});
const fileHandlers = createAgentManagementFileHandlers({
  getRoleByName: db.getRoleByName,
  getAgentWithVersionCount: db.getAgentWithVersionCount,
  getFiles: db.getFiles,
  checkPermission,
  hasCapability,
  removeAgentResourceFiles: db.removeAgentResourceFiles,
  processUpload: (req, res) =>
    handleFileUpload(
      req,
      createAgentManagementUploadResponse(res, req.file, req.body.tool_resource),
    ),
  deleteTempFile: fs.unlink,
  getUploadConfig: async (req, agent) => {
    const endpoint = agent.provider || EModelEndpoint.agents;
    const endpointType = resolveEndpointType(
      await getEndpointsConfig(req),
      EModelEndpoint.agents,
      endpoint,
    );
    const endpointConfig = getEndpointFileConfig({
      fileConfig: mergeFileConfig(req.config?.fileConfig),
      endpoint,
      endpointType,
    });
    return {
      endpoint,
      endpointType,
      disabled: endpointConfig.disabled,
      fileSizeLimit: endpointConfig.fileSizeLimit,
      fileLimit: endpointConfig.fileLimit,
      totalSizeLimit: endpointConfig.totalSizeLimit,
    };
  },
  isUploadPurposeEnabled: async (req, purpose) => {
    if (purpose === EToolResources.context) {
      return await checkCapability(req, AgentCapabilities.context);
    }
    /** Capability first: a purpose the deployment has switched off is rejected
     *  without a role read. */
    if (purpose === EToolResources.execute_code) {
      if (!(await checkCapability(req, AgentCapabilities.execute_code))) {
        return false;
      }
      return (await resolveToolRoleGrants({ req, getRoleByName: db.getRoleByName })).runCode;
    }
    if (purpose === EToolResources.file_search) {
      if (!(await checkCapability(req, AgentCapabilities.file_search))) {
        return false;
      }
      return (await resolveToolRoleGrants({ req, getRoleByName: db.getRoleByName })).fileSearch;
    }
    return true;
  },
  runUploadExclusive: createAgentUploadLock({ redisClient: ioredisClient }),
});
const sendUploadRateLimit = (_req, res) =>
  res.status(429).json({
    error: {
      code: 'invalid_request',
      message: 'Too many file upload requests. Try again later',
    },
  });
const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters({
  onLimit: sendUploadRateLimit,
});
const uploadSingleFile = async (req, res, next) => {
  try {
    const upload = await createMulterInstance({
      fileConfig: req.config?.fileConfig ?? null,
      resolveEndpoint: fileHandlers.getUploadConfig,
      uniqueTempPath: true,
    });
    return upload.single('file')(req, res, next);
  } catch (error) {
    return next(error);
  }
};
const handleUploadError = (error, _req, res, _next) => {
  const status = Number(error?.statusCode);
  const isMultipartRequestError =
    error?.name === 'MulterError' ||
    error?.code?.startsWith?.('LIMIT_') ||
    (Number.isInteger(status) && status >= 400 && status < 500);
  const code = isMultipartRequestError ? 'invalid_request' : 'internal_error';
  const mapped = mapAgentManagementError(code);
  return res.status(mapped.status).json(mapped.body);
};

router.use(requireAgentManagementAuth);
router.use(checkBan);

router.post('/', configMiddleware, createHandler);
router.get('/', readHandlers.list);
router.post(
  '/:id/files',
  configMiddleware,
  fileUploadIpLimiter,
  fileUploadUserLimiter,
  fileHandlers.authorizeUpload,
  uploadSingleFile,
  restoreTenantContextFromReq,
  fileHandlers.upload,
  handleUploadError,
);
router.get('/:id/files', fileHandlers.list);
router.delete('/:id/files/:fileId', fileHandlers.remove);
router.get('/:id', readHandlers.get);
router.patch('/:id', configMiddleware, updateHandler);
router.delete('/:id', deleteHandler);

router.use((_req, res) => {
  const { status, body } = mapAgentManagementError('not_found');
  return res.status(status).json(body);
});

module.exports = router;
