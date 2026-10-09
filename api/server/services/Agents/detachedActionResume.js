const { createAgentEventDetachedResumeHandler } = require('@librechat/api');
const methods = require('~/models');

const resumeAgentEventDetachedAction = createAgentEventDetachedResumeHandler({
  getAgentTriggerDelivery: methods.getAgentTriggerDelivery,
  /** Keep server module construction lazy while the typed package owns the
   * continuation protocol and owner validation. */
  enqueueAgentTrigger: (envelope, options) =>
    require('./triggers').enqueueAgentTrigger(envelope, options),
});

module.exports = { resumeAgentEventDetachedAction };
