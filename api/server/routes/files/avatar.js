const fs = require('fs').promises;
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  inspectContent,
  extractFileContent,
  hasActiveFileFieldPolicy,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedUninspectableFileField,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { filterFile } = require('~/server/services/Files/process');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const appConfig = req.config;
    filterFile({ req, file: req.file, image: true, isAvatar: true });
    if (hasActiveFileFieldPolicy(req.config?.filters, ['name', 'content'])) {
      const finding = inspectContent(extractFileContent({ name: req.file.originalname }), {
        filters: req.config.filters,
      });
      if (finding != null) {
        return res.status(400).json(contentFilterBlockResponse(finding));
      }
      const uninspectableField = getBlockedUninspectableFileField(req.config.filters, ['content']);
      if (uninspectableField != null) {
        return res.status(400).json(contentFilterUninspectableResponse(uninspectableField));
      }
    }

    const userId = req.user.id;
    const { manual } = req.body;
    const input = await fs.readFile(req.file.path);

    if (!userId) {
      throw new Error('User ID is undefined');
    }

    const fileStrategy = getFileStrategy(appConfig, { isAvatar: true });
    const desiredFormat = appConfig.imageOutputType;
    const resizedBuffer = await resizeAvatar({
      userId,
      input,
      desiredFormat,
    });

    const { processAvatar } = getStrategyFunctions(fileStrategy);
    const url = await processAvatar({
      buffer: resizedBuffer,
      userId,
      manual,
      tenantId: req.user.tenantId,
    });

    res.json({ url });
  } catch (error) {
    const message = 'An error occurred while uploading the profile picture';
    logger.error(message, error);
    res.status(500).json({ message });
  } finally {
    try {
      await fs.unlink(req.file.path);
      logger.debug('[/files/images/avatar] Temp. image upload file deleted');
    } catch {
      logger.debug('[/files/images/avatar] Temp. image upload file already deleted');
    }
  }
});

module.exports = router;
