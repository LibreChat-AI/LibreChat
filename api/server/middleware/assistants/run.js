const { GenerationJobManager, withAssistantRun } = require('@librechat/api');
const db = require('~/models');

/**
 * Registers an Assistants controller's runs with the account cleanup barrier, so account deletion
 * refuses new runs, stops the running ones, and waits for their writes before erasing the data.
 * @template {(req: ServerRequest, res: Express.Response) => Promise<unknown>} T
 * @param {T} controller
 */
const enrollAssistantRun = (controller) =>
  withAssistantRun(controller, {
    manager: GenerationJobManager,
    isPrincipalActive: (userId) => db.isAgentTriggerPrincipalActive(userId),
  });

module.exports = enrollAssistantRun;
