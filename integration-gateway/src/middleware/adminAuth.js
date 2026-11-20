'use strict';

const config = require('../config');

function extractBearer(header) {
  if (!header || typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

function adminAuth(req, res, next) {
  const token = extractBearer(req.headers.authorization);

  if (!token) {
    res.status(401).json({ error: 'Missing Authorization: Bearer <GATEWAY_ADMIN_TOKEN>' });
    return;
  }

  if (token !== config.gatewayAdminToken) {
    res.status(401).json({ error: 'Invalid admin token' });
    return;
  }

  next();
}

module.exports = { adminAuth };
