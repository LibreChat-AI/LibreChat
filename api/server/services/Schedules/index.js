let service;

/**
 * Build the schedule service on first use. Controllers import this facade in many
 * focused test/runtime paths that never use scheduling; eagerly loading Config and
 * the trigger worker made those paths initialize two unrelated service graphs just
 * by requiring a controller.
 */
function getService() {
  if (service != null) {
    return service;
  }
  const { createSchedulesService } = require('@librechat/api');
  const { getAppConfig } = require('~/server/services/Config/app');
  const {
    enqueueAgentTrigger,
    getAgentTriggerDelivery,
  } = require('~/server/services/Agents/triggers');
  const { resolveAgentFireAccess } = require('./access');
  const methods = require('~/models');
  const isUserDeleting = async (userId) => !(await methods.isAgentTriggerPrincipalActive(userId));

  service = createSchedulesService({
    preflightMCP: require('./mcp'),
    methods,
    getAppConfig,
    findUserById: (userId) => methods.findScheduleOwner(userId.toString()),
    findBalance: (userId, options) =>
      methods.findBalanceByUser(userId, { includeReservedCredits: true, ...options }),
    upsertBalance: (userId, { set, setOnInsert }) =>
      methods.upsertBalanceFields(userId, set ?? {}, setOnInsert ?? {}),
    initializeNullBalance: methods.initializeNullBalance,
    enqueueAgentTrigger,
    // Reconciliation reads the durable delivery to tell a still-live admission (a
    // deferred Retry-After) or a dead-letter apart from a genuinely orphaned run.
    getTriggerDelivery: getAgentTriggerDelivery,
    resolveAgentFireAccess,
    // Chat projects are user-owned, so this scoped read is both the existence and the
    // authorization check the fire-time destination precheck needs.
    getChatProject: (userId, projectId) => methods.getChatProject(userId, projectId),
    // Reuse the merged trigger/deletion admission fence. A schedule fire and every
    // generic trigger now fail closed on the same durable principal state.
    isUserDeleting,
  });
  return service;
}

const invoke =
  (method) =>
  (...args) =>
    getService()[method](...args);

/** Host adapter for the generic generation runtime's approval-expiry seam. The
 * callback is intentionally idempotent: a replica relay or schedule reconciliation
 * may re-drive the same retained terminal evidence after a transient failure. */
async function recordExpiredScheduleApproval(streamId, job) {
  if (!job?.scheduleId || !job?.scheduledFor) {
    return;
  }
  const recorded = await getService().recordScheduleOutcome({
    scheduleId: job.scheduleId,
    scheduledFor: job.scheduledFor,
    streamId,
    jobCreatedAt: job.createdAt,
    status: 'interrupted',
    conversationId: job.conversationId ?? streamId,
    error: 'Approval expired before a decision was made',
  });
  if (!recorded) {
    throw new Error(`Failed to settle expired scheduled approval ${job.scheduleId}`);
  }
}

module.exports = {
  getLimits: invoke('getLimits'),
  fireScheduleNow: invoke('fireScheduleNow'),
  recordScheduleOutcome: invoke('recordScheduleOutcome'),
  registerMCPSettlement: invoke('registerMCPSettlement'),
  recordMCPToolAuthFailure: (input) =>
    require('@librechat/api').recordScheduledMCPToolAuthFailure(
      input,
      () => getService().recordMCPToolAuthFailure,
      () => getService().getMCPReceiptRetryPolicy(input),
    ),
  beginScheduledStop: invoke('beginScheduledStop'),
  acknowledgeScheduledStopPersistence: invoke('acknowledgeScheduledStopPersistence'),
  claimScheduleResume: invoke('claimScheduleResume'),
  releaseScheduleResumeClaim: invoke('releaseScheduleResumeClaim'),
  finalizeScheduleResumeClaim: invoke('finalizeScheduleResumeClaim'),
  releaseScheduleResumeFence: invoke('releaseScheduleResumeFence'),
  isScheduleLive: invoke('isScheduleLive'),
  deleteScheduleForOwner: invoke('deleteScheduleForOwner'),
  quiesceUserSchedules: invoke('quiesceUserSchedules'),
  restoreUserSchedulesFromDeletion: invoke('restoreUserSchedulesFromDeletion'),
  initializeScheduleEngine: invoke('initializeScheduleEngine'),
  initializeScheduleErasureSweep: invoke('initializeScheduleErasureSweep'),
  recordExpiredScheduleApproval,
  isUserDeleting: async (userId) => {
    const methods = require('~/models');
    return !(await methods.isAgentTriggerPrincipalActive(userId));
  },
};
