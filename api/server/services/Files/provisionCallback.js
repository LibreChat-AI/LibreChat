const { createProvisionFilesCallback: createCallback } = require('@librechat/api');
const { provisionToCodeEnv, provisionToVectorDB } = require('~/server/services/Files/provision');
const db = require('~/models');

/* Wiring only: binds this workspace's provisioning service and file model to the
 * ON_TOOL_EXECUTE callback implemented in packages/api. */
function createProvisionFilesCallback({ req, agentToolContexts, resolvePrimaryAgentId }) {
  return createCallback({
    req,
    agentToolContexts,
    resolvePrimaryAgentId,
    provisionToCodeEnv,
    provisionToVectorDB,
    updateFile: db.updateFile,
    updateCodeEnvRef: db.updateFileCodeEnvRef,
    addEmbeddedEntity: db.addFileEmbeddedEntity,
  });
}

module.exports = { createProvisionFilesCallback };
