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
  const mongoose = require('mongoose');
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
    findUserById: (userId) =>
      mongoose.models.User.findById(userId).select('_id tenantId role').lean(),
    findBalance: (userId) => methods.findBalanceByUser(userId, { includeReservedCredits: true }),
    upsertBalance: (userId, { set, setOnInsert }) =>
      methods.upsertBalanceFields(userId, set ?? {}, setOnInsert ?? {}),
    // Compare-and-set: only initialize an existing record while its credit is still null.
    // No upsert — a CAS miss must re-read the winner, not insert a fresh balance. `null`
    // in the filter also matches a legacy record whose `tokenCredits` field is absent.
    initializeNullBalance: (userId, { tokenCredits, sync }) =>
      mongoose.models.Balance.findOneAndUpdate(
        { user: userId, tokenCredits: null },
        { $set: { tokenCredits, ...(sync && Object.keys(sync).length > 0 ? sync : {}) } },
        { new: true, sort: { _id: 1 } },
      ).lean(),
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
  recordMCPToolAuthFailure: (input) =>
    require('@librechat/api').recordScheduledMCPToolAuthFailure(
      input,
      () => getService().recordMCPToolAuthFailure,
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
  // Identity-fenced delete for a retained job whose run has since been settled
  // inline; reconciliation only reaches jobs whose run is still active.
  clearScheduledJob: (...args) => getService().engineDeps.clearReconciledJob(...args),
};
