const {
  resolveUploadAgent: resolveAgent,
  resolveEffectiveToolResource: resolveToolResource,
  resolveUploadEndpoint: resolveEndpoint,
  resolveUploadLLMDeliveryPath,
} = require('@librechat/api');
const db = require('~/models');

/* Wiring only: binds this workspace's agent model to the upload routing implemented in
 * packages/api. */
const resolveUploadAgent = (req, agent_id) => resolveAgent(req, agent_id, db.getAgent);

const resolveUploadEndpoint = ({ endpoint, agent_id, req }) =>
  resolveEndpoint({ req, metadata: { endpoint, agent_id }, getAgent: db.getAgent });

const resolveEffectiveToolResource = ({ req, metadata }) =>
  resolveToolResource({ req, metadata, getAgent: db.getAgent });

module.exports = {
  resolveUploadAgent,
  resolveUploadEndpoint,
  resolveUploadLLMDeliveryPath,
  resolveEffectiveToolResource,
};
