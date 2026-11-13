const express = require('express');
const { createSoraClient } = require('../services/VideoGeneration');

const router = express.Router();

router.post('/generate', async (req, res) => {
  try {
    const { prompt, n_seconds, height, width } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'A valid prompt is required' });
    }

    const client = createSoraClient();
    const job = await client.createVideoGeneration({
      prompt: prompt.trim(),
      n_seconds: n_seconds || 5,
      height: height || 480,
      width: width || 854,
    });

    return res.status(202).json({
      operationId: job.id,
      status: job.status,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;
    return res.status(status).json({ error: message });
  }
});

router.get('/status/:operationId', async (req, res) => {
  try {
    const { operationId } = req.params;

    if (!operationId) {
      return res.status(400).json({ error: 'Operation ID is required' });
    }

    const client = createSoraClient();
    const result = await client.getVideoGeneration(operationId);

    return res.status(200).json(result);
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;
    return res.status(status).json({ error: message });
  }
});

router.post('/generate-and-poll', async (req, res) => {
  try {
    const { prompt, n_seconds, height, width } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'A valid prompt is required' });
    }

    const client = createSoraClient();
    const job = await client.createVideoGeneration({
      prompt: prompt.trim(),
      n_seconds: n_seconds || 5,
      height: height || 480,
      width: width || 854,
    });

    const result = await client.pollVideoGeneration(job.id);

    return res.status(200).json(result);
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;
    return res.status(status).json({ error: message });
  }
});

router.delete('/:operationId', async (req, res) => {
  try {
    const { operationId } = req.params;

    if (!operationId) {
      return res.status(400).json({ error: 'Operation ID is required' });
    }

    const client = createSoraClient();
    await client.deleteVideoGeneration(operationId);

    return res.status(204).send();
  } catch (error) {
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message;
    return res.status(status).json({ error: message });
  }
});

module.exports = router;
