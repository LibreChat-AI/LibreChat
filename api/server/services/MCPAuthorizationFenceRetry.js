const mongoose = require('mongoose');
const {
  createMCPAuthorizationFenceRetryStorage,
  getTenantId,
  tenantStorage,
} = require('@librechat/data-schemas');
const { createMCPAuthorizationFenceRetryService } = require('@librechat/api');

let retryService;

function getRetryService() {
  retryService ??= createMCPAuthorizationFenceRetryService({
    getTenantId,
    storage: createMCPAuthorizationFenceRetryStorage(mongoose),
    runInRetryScope: (retry, operation) =>
      tenantStorage.run(
        {
          ...(typeof retry.tenantId === 'string' && retry.tenantId
            ? { tenantId: retry.tenantId }
            : {}),
          userId: String(retry.userId),
        },
        operation,
      ),
  });
  return retryService;
}

module.exports = {
  clearMCPAuthorizationFenceRetry: (...args) => getRetryService().clear(...args),
  drainMCPAuthorizationFenceRetries: (...args) => getRetryService().drain(...args),
  persistMCPAuthorizationFenceRetry: (...args) => getRetryService().persist(...args),
  startMCPAuthorizationFenceRetryWorker: (...args) => getRetryService().start(...args),
};
