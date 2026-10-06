const { logger } = require('@librechat/data-schemas');
const { getReasoningCapabilities } = require('@librechat/api');

/**
 * Returns the reasoning efforts each OpenRouter model accepts, per endpoint, or a 503 with a
 * stable code when a catalog could not be read so the client retries rather than caching it.
 * Resolution lives in `@librechat/api`; this controller only supplies the request config.
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */
async function reasoningCapabilitiesController(req, res) {
  try {
    const { capabilities, unavailable } = await getReasoningCapabilities(req.config);
    if (unavailable.length > 0) {
      return res.status(503).json({ error: 'reasoning_catalog_unavailable' });
    }
    res.json(capabilities);
  } catch (error) {
    logger.error('[reasoningCapabilitiesController]', error);
    res.status(500).json({ error: 'Failed to resolve reasoning capabilities' });
  }
}

module.exports = reasoningCapabilitiesController;
