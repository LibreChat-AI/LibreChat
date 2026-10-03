'use strict';

const express = require('express');
const { clientAuth } = require('../middleware/clientAuth');
const { getLcJwt } = require('../services/lcProvision');
const {
  chatCompletion,
  createResponseIdCaptureStream,
  listUserConversations,
  getConversationMessages,
} = require('../services/lcProxy');

const router = express.Router();

router.use(clientAuth);

function resolveRequestedAgentId(req) {
  const bodyAgentId = req.body?.agentId;
  if (typeof bodyAgentId === 'string' && bodyAgentId.trim()) {
    return bodyAgentId.trim();
  }
  const headerAgentId = req.headers['x-agent-id'];
  if (typeof headerAgentId === 'string' && headerAgentId.trim()) {
    return headerAgentId.trim();
  }
  return null;
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function sendError(res, err) {
  const status = err.status || 500;
  const payload = { error: err.message || 'Request failed' };
  if (err.code) {
    payload.code = err.code;
  }
  res.status(status).json(payload);
}

router.post('/chat', async (req, res) => {
  try {
    const { message, conversationId } = req.body ?? {};
    const { response, gatewayConversationId } = await chatCompletion({
      client: req.integrationClient,
      externalUserId: req.externalUserId,
      message,
      conversationId: conversationId ?? null,
      requestedAgentId: resolveRequestedAgentId(req),
      clientIp: clientIp(req),
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Conversation-Id', gatewayConversationId);

    if (!response.body) {
      res.status(502).json({ error: 'LibreChat returned an empty stream body' });
      return;
    }

    const { Readable } = require('node:stream');
    Readable.fromWeb(response.body)
      .pipe(createResponseIdCaptureStream(gatewayConversationId))
      .pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, err);
    }
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const conversations = await listUserConversations(
      req.integrationClient.clientId,
      req.externalUserId,
    );
    res.json({ conversations });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const jwt = await getLcJwt(req.integrationClient.clientId, req.externalUserId);
    const messages = await getConversationMessages(
      req.integrationClient.clientId,
      req.externalUserId,
      req.params.id,
      jwt,
    );
    res.json({ messages });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
