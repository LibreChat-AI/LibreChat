const { logger } = require('@librechat/data-schemas');
const { getReasoningCapabilities } = require('@librechat/api');

/**
 * Returns the reasoning efforts each OpenRouter model accepts, per endpoint.
 * Resolution lives in `@librechat/api`; this controller only supplies the request config.
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */
async function reasoningCapabilitiesController(req, res) {
  try {
    res.json(await getReasoningCapabilities(req.config));
  } catch (error) {
    logger.error('[reasoningCapabilitiesController]', error);
    res.status(500).json({ error: 'Failed to resolve reasoning capabilities' });
  }
}

module.exports = reasoningCapabilitiesController;
