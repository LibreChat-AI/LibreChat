const { promoteDrainedSteers, GenerationJobManager } = require('@librechat/api');
const db = require('~/models');

/** Trigger-service composition stays lazy: it is only needed once a steer is promoted. */
const lifecycle = {
  schedule: (turn) => require('~/server/services/Agents/triggers').scheduleAgentQueuedTurn(turn),
  cancel: (target) => require('~/server/services/Agents/triggers').cancelAgentQueuedTurn(target),
};

/** Hands a completed run's accepted-but-unapplied steers to durable queued turns
 * before its FINAL is published; see `promoteDrainedSteers`. */
const promoteUnappliedSteers = (req, input) =>
  promoteDrainedSteers(
    { ...input, user: { id: req.user?.id ?? '', tenantId: req.user?.tenantId } },
    { methods: db, lifecycle, steering: GenerationJobManager.steering },
  );

module.exports = { promoteUnappliedSteers };
