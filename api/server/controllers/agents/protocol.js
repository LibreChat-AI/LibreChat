const GENERATION_PROTOCOL_HEADER = 'x-librechat-generation-protocol';
const GENERATION_PROTOCOL_V1 = 1;
const GENERATION_PROTOCOL_V2 = 2;

function parseProtocolVersion(value) {
  if (value === GENERATION_PROTOCOL_V1 || value === '1') {
    return GENERATION_PROTOCOL_V1;
  }
  if (value === GENERATION_PROTOCOL_V2 || value === '2') {
    return GENERATION_PROTOCOL_V2;
  }
  return undefined;
}

/**
 * Reads every transport carrying the negotiation marker. If multiple markers
 * disagree, the lower protocol wins; a proxy or token-refresh path dropping
 * one marker must never upgrade a legacy request accidentally.
 */
function getRequestedGenerationProtocol(req) {
  const advertised = [
    req?.body?.generationProtocolVersion,
    req?.query?.generationProtocolVersion,
    req?.headers?.[GENERATION_PROTOCOL_HEADER],
  ]
    .filter((value) => value != null)
    .map(parseProtocolVersion);

  if (advertised.length === 0 || advertised.some((value) => value == null)) {
    return GENERATION_PROTOCOL_V1;
  }
  return advertised.every((value) => value === GENERATION_PROTOCOL_V2)
    ? GENERATION_PROTOCOL_V2
    : GENERATION_PROTOCOL_V1;
}

/** The current server contract supports protocol v2 for every built-in store.
 * Client advertisement still decides whether a new generation uses v1 or v2. */
function getServerGenerationProtocol() {
  return GENERATION_PROTOCOL_V2;
}

function getJobGenerationProtocol(job) {
  return parseProtocolVersion(job?.metadata?.generationProtocolVersion) ?? GENERATION_PROTOCOL_V1;
}

/** Selects an immutable protocol for a newly created generation. */
function negotiateNewGenerationProtocol(req) {
  return Math.min(getRequestedGenerationProtocol(req), getServerGenerationProtocol());
}

/**
 * Existing jobs keep the protocol they were created with. This is what makes
 * v1 jobs safe to finish after the fleet-wide v2 gate is enabled.
 */
function negotiateExistingGenerationProtocol(req, job) {
  return Math.min(getRequestedGenerationProtocol(req), getJobGenerationProtocol(job));
}

module.exports = {
  GENERATION_PROTOCOL_HEADER,
  GENERATION_PROTOCOL_V1,
  GENERATION_PROTOCOL_V2,
  getRequestedGenerationProtocol,
  getServerGenerationProtocol,
  getJobGenerationProtocol,
  negotiateNewGenerationProtocol,
  negotiateExistingGenerationProtocol,
};
