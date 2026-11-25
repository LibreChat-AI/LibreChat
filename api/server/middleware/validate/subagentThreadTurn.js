const { createSubagentThreadTurnGuard, GenerationJobManager } = require('@librechat/api');
const subagentThreadTaskStore = require('~/server/services/Endpoints/agents/subagentThreadStore');
const db = require('~/models');

module.exports = createSubagentThreadTurnGuard({
  getConvo: db.getConvo,
  getEventBinding: db.getAgentEventBinding,
  isHumanResumeAllowed: async ({ userId, tenantId, conversationId }) => {
    const job = await GenerationJobManager.getJob(conversationId);
    return (
      job?.status === 'requires_action' &&
      job.metadata?.userId === userId &&
      (job.metadata?.tenantId ?? undefined) === tenantId
    );
  },
  store: subagentThreadTaskStore,
});
