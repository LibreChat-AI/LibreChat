const fs = require('fs');
const net = require('net');
const path = require('path');
require('dotenv').config();

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/LibreChat-e2e';
const DEFAULT_RUNTIME_ENV_PATH = path.resolve(__dirname, '../specs/.test-results/runtime-env.json');
const REDIS_STREAM_STARTUP_TIMEOUT_MS = 15_000;
const REDIS_PING_TIMEOUT_MS = 10_000;
let mongoServer;

function decodeMongoValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getMongoScheme(uri) {
  const schemeEnd = uri.indexOf('://');
  return schemeEnd === -1 ? '' : uri.slice(0, schemeEnd).toLowerCase();
}

function getMongoAuthority(uri) {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) {
    return '';
  }

  const withoutScheme = uri.slice(schemeEnd + 3);
  return withoutScheme.split(/[/?#]/, 1)[0];
}

function getMongoDbName(uri) {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) {
    return 'LibreChat-e2e';
  }

  const withoutScheme = uri.slice(schemeEnd + 3);
  const pathStart = withoutScheme.indexOf('/');
  if (pathStart === -1) {
    return 'LibreChat-e2e';
  }

  const pathname = withoutScheme.slice(pathStart + 1).split(/[?#]/, 1)[0];
  const dbName = pathname.split('/', 1)[0];
  return dbName ? decodeMongoValue(dbName) : 'LibreChat-e2e';
}

function normalizeMongoPort(port) {
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 27017;
}

function parseMongoHost(hostEntry) {
  if (!hostEntry) {
    return null;
  }

  if (hostEntry.startsWith('[')) {
    const hostEnd = hostEntry.indexOf(']');
    if (hostEnd === -1) {
      return null;
    }

    const host = hostEntry.slice(1, hostEnd);
    const port = hostEntry[hostEnd + 1] === ':' ? hostEntry.slice(hostEnd + 2) : '';
    return { host, port: normalizeMongoPort(port) };
  }

  const [host, port] = hostEntry.split(':');
  return host ? { host, port: normalizeMongoPort(port) } : null;
}

function parseMongoUri(uri) {
  const scheme = getMongoScheme(uri);
  const authority = getMongoAuthority(uri);
  const hosts = authority
    .slice(authority.lastIndexOf('@') + 1)
    .split(',')
    .filter(Boolean);
  const parsedHost =
    scheme === 'mongodb+srv' || hosts.length !== 1 ? null : parseMongoHost(hosts[0]);

  return {
    dbName: getMongoDbName(uri),
    host: parsedHost?.host ?? '',
    port: parsedHost?.port ?? 27017,
    canProbe: Boolean(parsedHost),
  };
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function withDbName(uri, dbName) {
  const parsed = new URL(uri);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function writeRuntimeEnv() {
  const runtimeEnvPath = process.env.E2E_RUNTIME_ENV_PATH || DEFAULT_RUNTIME_ENV_PATH;
  fs.mkdirSync(path.dirname(runtimeEnvPath), { recursive: true });
  fs.writeFileSync(runtimeEnvPath, JSON.stringify({ MONGO_URI: process.env.MONGO_URI }, null, 2));
}

async function maybeStartMemoryMongo() {
  const mongoUri = process.env.MONGO_URI ?? DEFAULT_MONGO_URI;
  const mode = process.env.E2E_USE_MEMORY_MONGO ?? 'auto';

  if (mode === 'false') {
    process.env.MONGO_URI = mongoUri;
    writeRuntimeEnv();
    return;
  }

  const { dbName, host, port, canProbe } = parseMongoUri(mongoUri);
  if (mode === 'auto' && (!canProbe || !isLocalHost(host) || (await canConnect(host, port)))) {
    process.env.MONGO_URI = mongoUri;
    writeRuntimeEnv();
    return;
  }

  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName,
      ip: '127.0.0.1',
    },
  });
  process.env.MONGO_URI = withDbName(mongoServer.getUri(), dbName);
  writeRuntimeEnv();
  console.log(`[e2e] Started memory MongoDB at ${process.env.MONGO_URI}`);
}

async function shutdown() {
  if (mongoServer) {
    await mongoServer.stop();
  }
}

async function requireRedisStreams() {
  if (process.env.E2E_REQUIRE_REDIS_STREAMS !== 'true') {
    return;
  }
  const { ioredisClient } = require('@librechat/api');
  if (!ioredisClient) {
    throw new Error('[e2e] Redis stream mode was required but no Redis client was configured');
  }
  let timeout;
  try {
    await Promise.race([
      ioredisClient.ping(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`[e2e] Redis did not respond within ${REDIS_PING_TIMEOUT_MS}ms`)),
          REDIS_PING_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyRedisStreams() {
  if (process.env.E2E_REQUIRE_REDIS_STREAMS !== 'true') {
    return;
  }
  const { GenerationJobManager } = require('@librechat/api');
  const deadline = Date.now() + REDIS_STREAM_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (GenerationJobManager.isRedis) {
      console.log('[e2e] Verified Redis-backed generation streams');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('[e2e] Redis stream mode was required but the server fell back to memory');
}

process.once('SIGINT', async () => {
  await shutdown();
  process.exit(130);
});

process.once('SIGTERM', async () => {
  await shutdown();
  process.exit(143);
});

function startServer() {
  return maybeStartMemoryMongo()
    .then(requireRedisStreams)
    .then(async () => {
      require(path.resolve(__dirname, '../../api/server/index.js'));
      await verifyRedisStreams();
    })
    .catch((error) => {
      console.error('[e2e] Failed to start test server:', error);
      process.exit(1);
    });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  parseMongoUri,
  startServer,
};
