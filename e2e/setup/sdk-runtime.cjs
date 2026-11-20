const { Run } = require('@librechat/agents');

module.exports = {
  protocolVersion: 1,
  async createRun({ config, identity }) {
    if (!Object.isFrozen(identity) || identity.runId !== config.runId || !identity.userId) {
      throw new Error('SDK runtime identity was not established by the host');
    }
    return Run.create(config);
  },
};
