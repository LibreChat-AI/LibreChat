const {
  createTermsBlockCheck,
  skipUntilTermsAccepted,
  createSkillBlobReserver,
  createSkillBufferWriter,
  createGitHubSkillSyncRunner,
  createSkillSyncTriggerOrchestrator,
  startGitHubSkillSyncScheduler,
} = require('@librechat/api');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { deleteSkillForLegacy } = require('./deletion');

const isTermsAcceptanceRequired = createTermsBlockCheck({ getAppConfig });

const SYSTEM_USER_ID = '000000000000000000000000';
const reserveSkillBlobForConfig = createSkillBlobReserver({
  getFileStrategy,
  getStrategyFunctions,
});
const saveSkillBuffer = createSkillBufferWriter({ getStrategyFunctions });

let appConfigRef;
let runner;
let scheduler;

async function loadCurrentAppConfig() {
  try {
    const appConfig = await getAppConfig({ baseOnly: true });
    appConfigRef = appConfig;
    return appConfig;
  } catch (error) {
    if (appConfigRef) {
      return appConfigRef;
    }
    throw error;
  }
}

async function getSyncConfig(loadAppConfig = loadCurrentAppConfig) {
  const appConfig = await loadAppConfig();
  return appConfig?.skillSync;
}

async function getSyntheticReq({ userId = SYSTEM_USER_ID, tenantId, loadAppConfig } = {}) {
  const appConfig = await (loadAppConfig ?? loadCurrentAppConfig)();
  return {
    config: appConfig,
    user: {
      id: userId,
      _id: userId,
      tenantId,
    },
  };
}

function withBaseSkillSyncConfig(req, baseConfig) {
  if (!req?.config || req.config.config?.skillSync !== undefined) {
    return req;
  }
  return {
    ...req,
    config: {
      ...req.config,
      config: {
        ...(req.config.config ?? {}),
        skillSync: baseConfig?.skillSync,
      },
    },
  };
}

function createRunner({ getConfig, loadAppConfig, allowServerCredentials = true } = {}) {
  const resolveAppConfig = loadAppConfig ?? loadCurrentAppConfig;
  const resolveConfig = getConfig ?? (() => getSyncConfig(resolveAppConfig));
  const createdRunner = createGitHubSkillSyncRunner({
    getConfig: resolveConfig,
    getCredentialToken: db.getSkillSyncCredentialToken,
    getCredentialSummary: db.getSkillSyncCredentialSummary,
    listCredentials: db.listSkillSyncCredentials,
    listStatuses: db.listSkillSyncStatuses,
    upsertStatus: db.upsertSkillSyncStatus,
    tryAcquireLock: db.tryAcquireSkillSyncLock,
    refreshLock: db.refreshSkillSyncLock,
    releaseLock: db.releaseSkillSyncLock,
    createSkill: db.createSkill,
    updateSkill: db.updateSkill,
    getSkillById: db.getSkillById,
    findSkillBySourceIdentity: db.findSkillBySourceIdentity,
    listSkillsBySource: db.listSkillsBySource,
    listSkillFiles: db.listSkillFiles,
    getSkillFileByPath: db.getSkillFileByPath,
    upsertSkillFile: db.upsertSkillFile,
    reserveSkillUploadIntent: db.reserveSkillUploadIntent,
    transitionSkillUploadIntent: db.transitionSkillUploadIntent,
    queueCommittedSkillUploadCleanup: db.queueCommittedSkillUploadCleanup,
    markSkillUploadIntentCleaned: db.markSkillUploadIntentCleaned,
    finishSkillUploadCleanupHold: db.finishSkillUploadCleanupHold,
    deleteSkillFile: db.deleteSkillFile,
    deleteSkill: deleteSkillForLegacy,
    reserveBlob: (options) => reserveSkillBlobForConfig(resolveAppConfig(), options),
    grantPermission: async ({
      principalType,
      principalId,
      resourceType,
      resourceId,
      accessRoleId,
      grantedBy,
    }) => {
      // Default access roles are seeded globally (no tenantId) under runAsSystem,
      // but the runner may execute inside a source's tenant context. Resolve the
      // role outside tenant isolation so the global role matches, then write the
      // ACL entry in the active (tenant) context so tenant users can see it.
      const role = await runAsSystem(() => db.findRoleByIdentifier(accessRoleId));
      if (!role) {
        throw new Error(`Role ${accessRoleId} not found`);
      }
      if (role.resourceType !== resourceType) {
        throw new Error(
          `Role ${accessRoleId} is for ${role.resourceType} resources, not ${resourceType}`,
        );
      }
      return db.grantPermission(
        principalType,
        principalId,
        resourceType,
        resourceId,
        role.permBits,
        grantedBy,
        undefined,
        role._id,
      );
    },
    saveBuffer: saveSkillBuffer,
    deleteFile: async (file) => {
      const strategy = getStrategyFunctions(file.source);
      if (!strategy.deleteFile) {
        throw new Error(`Skill storage backend ${file.source} cannot delete files`);
      }
      await strategy.deleteFile(
        await getSyntheticReq({
          userId: file.user?.toString?.() ?? file.user ?? SYSTEM_USER_ID,
          tenantId: file.tenantId,
          loadAppConfig: resolveAppConfig,
        }),
        file,
      );
    },
    allowServerCredentials,
  });
  return {
    getStatus: createdRunner.getStatus,
    runOnce: createdRunner.runOnce,
  };
}

const triggerOrchestrator = createSkillSyncTriggerOrchestrator({
  createRunner,
  logger,
});

function getGitHubSkillSyncRunnerForRequest(req) {
  return triggerOrchestrator.getRunnerForAdminRequest(withBaseSkillSyncConfig(req, appConfigRef));
}

async function runGitHubSkillSyncForRequest(req) {
  const baseConfig = await loadCurrentAppConfig();
  return triggerOrchestrator.maybeRunForRequest({
    ...withBaseSkillSyncConfig(req, baseConfig),
    skillSyncAllowServerCredentials: false,
  });
}

/** The list route is a read the terms gate lets through; the sync it starts is processing. */
const maybeRunGitHubSkillSyncForRequest = skipUntilTermsAccepted(
  isTermsAcceptanceRequired,
  runGitHubSkillSyncForRequest,
  false,
);

function initializeGitHubSkillSync(appConfig) {
  appConfigRef = appConfig;
  runner = createRunner();
  scheduler = startGitHubSkillSyncScheduler({
    getConfig: getSyncConfig,
    runner,
  });
  return { runner, scheduler };
}

function getGitHubSkillSyncRunner() {
  if (!runner) {
    runner = createRunner();
  }
  return runner;
}

function stopGitHubSkillSyncScheduler() {
  if (scheduler) {
    scheduler.stop();
    scheduler = undefined;
  }
}

module.exports = {
  initializeGitHubSkillSync,
  getGitHubSkillSyncRunner,
  getGitHubSkillSyncRunnerForRequest,
  maybeRunGitHubSkillSyncForRequest,
  stopGitHubSkillSyncScheduler,
};
