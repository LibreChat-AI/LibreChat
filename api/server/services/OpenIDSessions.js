const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { createOpenIDSessionsRuntime } = require('@librechat/api');
const { isOpenIdConfigured } = require('~/server/utils/isOpenIdConfigured');

const runtime = createOpenIDSessionsRuntime({ mongoose, logger, isOpenIdConfigured });

module.exports = {
  isOpenIdConfigured: runtime.isOpenIdConfigured,
  connectOpenIDAuthorization: runtime.connectOpenIDAuthorization,
  getAuthorizationMethods: runtime.getAuthorizationMethods,
  getAuthorizationDeps: runtime.getAuthorizationDeps,
  getLoginDeps: runtime.getLoginDeps,
  getRevokeDeps: runtime.getRevokeDeps,
  getLeaseMethods: runtime.getLeaseMethods,
  getOpenIdClientId: runtime.getOpenIdClientId,
  sessionAuthorizationRef: runtime.sessionAuthorizationRef,
};
