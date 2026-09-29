const crypto = require('crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  reportLocatorTraversalFailure,
  createContentFilter,
  extractPresetContent,
  projectStoredPresets,
} = require('@librechat/api');
const { getPresets, savePreset, deletePresets } = require('~/models');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');

const router = express.Router();
const filterPresetContent = createContentFilter({
  onTraversalFailure: reportLocatorTraversalFailure,
  getFilters: (req) => req.config?.filters,
  extract: (req) => extractPresetContent(req.body),
});

router.use(requireJwtAuth);

router.get('/', configMiddleware, async (req, res) => {
  const presets = projectStoredPresets(await getPresets(req.user.id), req.config?.filters);
  res.status(200).json(presets);
});

router.post('/', configMiddleware, filterPresetContent, async (req, res) => {
  const update = req.body || {};

  update.presetId = update?.presetId || crypto.randomUUID();

  try {
    const preset = await savePreset(req.user.id, update);
    res.status(201).json(preset);
  } catch (error) {
    logger.error('[/presets] error saving preset', error);
    res.status(500).send('There was an error when saving the preset');
  }
});

router.post('/delete', async (req, res) => {
  let filter = {};
  const { presetId } = req.body || {};

  if (presetId) {
    filter = { presetId };
  }

  logger.debug('[/presets/delete] delete preset filter', filter);

  try {
    const deleteCount = await deletePresets(req.user.id, filter);
    res.status(201).json(deleteCount);
  } catch (error) {
    logger.error('[/presets/delete] error deleting presets', error);
    res.status(500).send('There was an error deleting the presets');
  }
});

module.exports = router;
