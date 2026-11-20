'use strict';

const crypto = require('crypto');
const { Transform } = require('node:stream');
const config = require('../config');
const db = require('../db');
const { getOrCreateApiKey, getLcJwt } = require('./lcProvision');

function denyAgent(message, clientId, requestedAgentId, ip) {
  db.insertAudit({
    actorType: 'client',
    actorId: clientId,
    action: 'chat.denied_agent',
    clientId,
    ip,
    detailJson: JSON.stringify({ requestedAgentId }),
  });
  const error = new Error(message);
  error.status = 403;
  error.code = 'access_denied';
  throw error;
}

function resolveAgentId({ client, requestedAgentId, convoAgentId, isExistingConversation }) {
  const whitelist = db.getClientAgentIds(client.clientId);

  if (convoAgentId) {
    if (requestedAgentId && requestedAgentId !== convoAgentId) {
      const error = new Error('agentId does not match the agent bound to this conversation');
      error.status = 409;
      error.code = 'agent_mismatch';
      throw error;
    }
    return convoAgentId;
  }

  if (isExistingConversation) {
    const defaultId = client.lcAgentId || config.lcDefaultAgentId;
    if (!defaultId) {
      const error = new Error('LC agent id is not configured (lc_agent_id or LC_DEFAULT_AGENT_ID)');
      error.status = 503;
      error.code = 'agent_not_configured';
      throw error;
    }
    return defaultId;
  }

  let agentId = requestedAgentId || client.lcAgentId || config.lcDefaultAgentId;
  if (!agentId) {
    const error = new Error('LC agent id is not configured (lc_agent_id or LC_DEFAULT_AGENT_ID)');
    error.status = 503;
    error.code = 'agent_not_configured';
    throw error;
  }

  if (whitelist.length > 0) {
    if (!whitelist.includes(agentId)) {
      return null;
    }
    return agentId;
  }

  const allowedDefault = client.lcAgentId || config.lcDefaultAgentId;
  if (requestedAgentId && requestedAgentId !== allowedDefault) {
    return null;
  }
  return allowedDefault;
}

function generateLcConversationId() {
  return crypto.randomUUID();
}

async function resolveConversation(clientId, externalUserId, conversationId) {
  if (!conversationId) {
    return {
      gatewayId: crypto.randomUUID(),
      lcConversationId: generateLcConversationId(),
      lcAgentId: null,
      isNew: true,
    };
  }

  const conv = db.findConversation(conversationId, clientId, externalUserId);
  if (!conv) {
    const error = new Error('Conversation not found or access denied');
    error.status = 403;
    error.code = 'access_denied';
    throw error;
  }

  return {
    gatewayId: conv.id,
    lcConversationId: conv.lcConversationId,
    lcAgentId: conv.lcAgentId || null,
    lcLastResponseId: conv.lcLastResponseId || null,
    isNew: false,
  };
}

async function ensureLcConversation({ clientId, externalUserId, lcConversationId, title }) {
  const jwt = await getLcJwt(clientId, externalUserId);
  const response = await fetch(`${config.lcBaseUrl}/api/convos/update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      arg: {
        conversationId: lcConversationId,
        title,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`LibreChat conversation create failed (${response.status}): ${body}`);
    error.status = response.status;
    throw error;
  }
}

async function chatCompletion({
  client,
  externalUserId,
  message,
  conversationId,
  requestedAgentId,
  clientIp,
}) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    const error = new Error('message is required');
    error.status = 400;
    throw error;
  }

  const convo = await resolveConversation(client.clientId, externalUserId, conversationId);
  const agentId = resolveAgentId({
    client,
    requestedAgentId,
    convoAgentId: convo.lcAgentId,
    isExistingConversation: !convo.isNew,
  });

  if (!agentId) {
    denyAgent(
      'agentId is not allowed for this client',
      client.clientId,
      requestedAgentId,
      clientIp,
    );
  }

  const apiKey = await getOrCreateApiKey(client.clientId, externalUserId);
  const title = message.trim().slice(0, 80);

  if (convo.isNew) {
    await ensureLcConversation({
      clientId: client.clientId,
      externalUserId,
      lcConversationId: convo.lcConversationId,
      title,
    });
    db.createConversation({
      id: convo.gatewayId,
      clientId: client.clientId,
      externalUserId,
      lcConversationId: convo.lcConversationId,
      title,
      lcAgentId: agentId,
    });
  }

  const previousResponseId = resolvePreviousResponseId(convo);

  const response = await fetch(`${config.lcBaseUrl}/api/agents/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agentId,
      input: message.trim(),
      stream: true,
      store: true,
      previous_response_id: previousResponseId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`LibreChat responses failed (${response.status}): ${body}`);
    error.status = response.status;
    throw error;
  }

  return { response, gatewayConversationId: convo.gatewayId };
}

function resolvePreviousResponseId(convo) {
  if (convo.isNew) {
    return convo.lcConversationId;
  }

  return convo.lcLastResponseId || convo.lcConversationId;
}

function createResponseIdCaptureStream(gatewayConversationId) {
  let buffer = '';

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) {
          continue;
        }

        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.type === 'response.completed' && payload.response?.id) {
            db.updateConversationLastResponse(gatewayConversationId, payload.response.id);
          }
        } catch {
          // Ignore malformed SSE payloads.
        }
      }

      callback(null, chunk);
    },
  });
}

async function listUserConversations(clientId, externalUserId) {
  return db.listConversations(clientId, externalUserId);
}

async function getConversationMessages(clientId, externalUserId, conversationId, jwt) {
  const conv = db.findConversation(conversationId, clientId, externalUserId);
  if (!conv) {
    const error = new Error('Conversation not found or access denied');
    error.status = 403;
    error.code = 'access_denied';
    throw error;
  }

  const response = await fetch(
    `${config.lcBaseUrl}/api/messages/${encodeURIComponent(conv.lcConversationId)}`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`LibreChat messages failed (${response.status}): ${body}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

module.exports = {
  chatCompletion,
  createResponseIdCaptureStream,
  listUserConversations,
  getConversationMessages,
};
