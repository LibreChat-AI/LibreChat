'use strict';

const crypto = require('crypto');
const config = require('../config');
const { encrypt, decrypt } = require('../crypto');
const db = require('../db');

/** @type {Map<string, { token: string, expiresAt: number }>} */
const jwtCache = new Map();

function cacheKey(clientId, externalUserId) {
  return `${clientId}:${externalUserId}`;
}

function decodeJwtExpiryMs(token) {
  const segment = token.split('.')[1];
  if (!segment) {
    return Date.now() + 15 * 60 * 1000;
  }

  const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (typeof payload.exp === 'number') {
    return payload.exp * 1000;
  }

  return Date.now() + 15 * 60 * 1000;
}

function getCachedJwt(clientId, externalUserId) {
  const cached = jwtCache.get(cacheKey(clientId, externalUserId));
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now() + 60_000) {
    jwtCache.delete(cacheKey(clientId, externalUserId));
    return null;
  }

  return cached.token;
}

function setCachedJwt(clientId, externalUserId, token) {
  jwtCache.set(cacheKey(clientId, externalUserId), {
    token,
    expiresAt: decodeJwtExpiryMs(token),
  });
}

function buildLcEmail(clientId, externalUserId) {
  const local = `${clientId}+${encodeURIComponent(externalUserId)}`;
  return `${local}@integration.internal`;
}

function buildUsername(clientId, externalUserId) {
  const digest = crypto.createHash('sha256').update(`${clientId}:${externalUserId}`).digest('hex');
  return `gw_${clientId}_${digest.slice(0, 16)}`;
}

async function lcFetch(path, options = {}) {
  const url = `${config.lcBaseUrl}${path}`;
  const response = await fetch(url, options);
  return response;
}

async function registerLcUser({ email, password, name, username }) {
  const response = await lcFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      confirm_password: password,
      name,
      username,
    }),
  });

  if (response.ok) {
    return;
  }

  const body = await response.text();
  if (response.status === 200 || body.includes('already')) {
    return;
  }

  throw new Error(`LibreChat register failed (${response.status}): ${body}`);
}

async function loginLcUser(email, password) {
  const response = await lcFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LibreChat login failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (!data.token) {
    throw new Error('LibreChat login did not return a token');
  }

  return { token: data.token, user: data.user };
}

async function createLcApiKey(jwt, label) {
  const response = await lcFetch('/api/api-keys', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: label }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LibreChat API key creation failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (!data.key) {
    throw new Error('LibreChat API key response missing key');
  }

  return data.key;
}

async function getOrCreateApiKey(clientId, externalUserId) {
  const existing = db.findUserMapping(clientId, externalUserId);
  if (existing) {
    return decrypt(existing.lcApiKeyEnc);
  }

  const email = buildLcEmail(clientId, externalUserId);
  const password = crypto.randomBytes(24).toString('hex');
  const username = buildUsername(clientId, externalUserId);
  const name = `Gateway ${clientId} ${externalUserId}`.slice(0, 80);

  await registerLcUser({ email, password, name, username });
  const { token, user } = await loginLcUser(email, password);
  setCachedJwt(clientId, externalUserId, token);
  const apiKey = await createLcApiKey(token, `gw-${clientId}-${externalUserId}`.slice(0, 64));

  db.saveUserMapping({
    clientId,
    externalUserId,
    lcEmail: email,
    lcPasswordEnc: encrypt(password),
    lcApiKeyEnc: encrypt(apiKey),
    lcUserId: user?.id ?? user?._id ?? null,
  });

  return apiKey;
}

async function getLcJwt(clientId, externalUserId) {
  const cached = getCachedJwt(clientId, externalUserId);
  if (cached) {
    return cached;
  }

  const mapping = db.findUserMapping(clientId, externalUserId);
  if (!mapping) {
    await getOrCreateApiKey(clientId, externalUserId);
    return getLcJwt(clientId, externalUserId);
  }

  const password = decrypt(mapping.lcPasswordEnc);
  const { token } = await loginLcUser(mapping.lcEmail, password);
  setCachedJwt(clientId, externalUserId, token);
  return token;
}

module.exports = {
  getOrCreateApiKey,
  getLcJwt,
  buildLcEmail,
};
