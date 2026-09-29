// const mongoose = require('mongoose');
// const { createMethods } = require('@librechat/data-schemas');
// const { matchModelName, findMatchingPattern, isDeploymentSkillId } = require('@librechat/api');
// const getLogStores = require('~/cache/getLogStores');

// const methods = createMethods(mongoose, {
//   matchModelName,
//   findMatchingPattern,
//   isExternalSkillId: isDeploymentSkillId,
//   getCache: getLogStores,
// });
const { methods } = require('~/db/connect');

const benign = {
  getApplicableConfigs: async () => [],
  getUserPrincipals: async () => [],
  hasAnyConfigReadAccess: async () => false,
  hasCapabilityForPrincipals: async () => false,
  getHeldCapabilities: async () => [],
  getToolCallsByConvo: async () => [],
  listMCPAuthorizationFenceRetries: async () => [],
  upsertMCPAuthorizationFenceRetry: async () => undefined,
  deleteMCPAuthorizationFenceRetry: async () => undefined,
  deferMCPAuthorizationFenceRetry: async () => undefined,
  getConvoFiles: methods.getConvoFiles,
  getUserKeyValues: async () => ({}),
  getUserKeyExpiry: async () => null,
  findOnePluginAuth: async () => null,
  findBalanceByUser: async () => null,
  upsertBalanceFields: async () => null,
  getMultiplier: () => 1,
  getCacheMultiplier: () => 1,
  spendTokens: async () => undefined,
  reserveBalance: async () => null,
  renewBalanceReservation: async () => false,
  releaseBalanceReservation: async () => undefined,
  deleteToolCalls: async () => ({ deletedCount: 0 }),
  getAgentEventActorReceiptStorageMetrics: async () => ({ total: 0 }),
  getAgentEventActorReconciliationStorageMetrics: async () => ({ pending: 0 }),
  getAgentEventBinding: async () => null,
  getAgentEventActorSnapshot: async () => null,
  isSubagentOwnerAdmissible: async () => true,
  fenceSubagentAdmission: async () => undefined,
  renewSubagentAdmission: async () => true,
  releaseSubagentAdmission: async () => undefined,
  acquireSubagentThreadLease: async () => null,
  claimSubagentTaskResult: async () => false,
  releaseSubagentTaskResultClaim: async () => false,
  countActiveSubagentThreadLeases: async () => 0,
  getSubagentTaskControlReplay: async () => null,
  listActiveSubagentThreadLeases: async () => [],
  recordSubagentTaskControlReceipt: async () => false,
  releaseSubagentThreadLease: async () => false,
  reserveSubagentThread: async () => null,
  renewSubagentThreadLease: async () => false,
};

const seedDatabase = async () => {
  // await methods.seedDefaultRoles();
  // await methods.ensureDefaultCategories();
  // await methods.seedSystemGrants();
  await methods.initializeRoles();
};

// module.exports = {
//   ...methods,
//   seedDatabase,
// };
module.exports = { ...methods, ...benign, seedDatabase };
