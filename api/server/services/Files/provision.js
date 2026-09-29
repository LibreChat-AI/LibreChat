const { createProvisionService } = require('@librechat/api');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { uploadVectors } = require('./VectorDB/crud');
const { getStrategyFunctions } = require('./strategies');

/* Wiring only: the provisioning logic lives in packages/api, where it is type checked.
 * Storage strategies, vector upload, and credential lookup are api-workspace concerns,
 * so they are bound here and injected.
 *
 * Built on first use rather than at module load: this module is reachable from the
 * OpenAI-compatible controllers, whose suites partially mock @librechat/api, and a
 * load-time call would throw before any provisioning is requested. */
let service;
const getService = () =>
  (service ??= createProvisionService({ getStrategyFunctions, uploadVectors, loadAuthValues }));

module.exports = {
  loadCodeApiKey: (...args) => getService().loadCodeApiKey(...args),
  provisionToCodeEnv: (...args) => getService().provisionToCodeEnv(...args),
  provisionToVectorDB: (...args) => getService().provisionToVectorDB(...args),
  checkCodeEnvFileAlive: (...args) => getService().checkCodeEnvFileAlive(...args),
  checkSessionsAlive: (...args) => getService().checkSessionsAlive(...args),
};
