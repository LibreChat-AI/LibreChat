'use strict';

const bcrypt = require('bcryptjs');
const db = require('../db');

function extractBearer(header) {
  if (!header || typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

function clientAuth(req, res, next) {
  const clientId = req.headers['x-client-id'];
  const secret = extractBearer(req.headers.authorization);

  if (!clientId || typeof clientId !== 'string' || !secret) {
    res.status(401).json({
      error: 'Missing X-Client-Id or Authorization: Bearer <client_secret>',
    });
    return;
  }

  const externalUserId = req.headers['x-external-user-id'];
  if (!externalUserId || typeof externalUserId !== 'string') {
    res.status(400).json({ error: 'Missing X-External-User-Id header' });
    return;
  }

  const client = db.findClient(clientId.trim());
  if (!client || !client.enabled) {
    res.status(401).json({ error: 'Unknown or disabled client' });
    return;
  }

  if (!bcrypt.compareSync(secret, client.clientSecretHash)) {
    res.status(401).json({ error: 'Invalid client credentials' });
    return;
  }

  req.integrationClient = client;
  req.externalUserId = externalUserId.trim();
  next();
}

module.exports = { clientAuth };
