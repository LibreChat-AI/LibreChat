'use strict';

const path = require('path');

const config = {
  port: Number(process.env.GATEWAY_PORT ?? process.env.PORT) || 8090,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  lcBaseUrl: (process.env.LC_BASE_URL || 'http://localhost:3080').replace(/\/$/, ''),
  lcDefaultAgentId: process.env.LC_DEFAULT_AGENT_ID || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  demoClientId: process.env.DEMO_CLIENT_ID || 'demo_app',
  demoClientSecret: process.env.DEMO_CLIENT_SECRET || 'demo_secret_change_me',
  gatewayAdminToken: process.env.GATEWAY_ADMIN_TOKEN || '',
  adminRateLimitRpm: Number(process.env.ADMIN_RATE_LIMIT_RPM) || 120,
};

if (config.encryptionKey.length < 32) {
  console.warn(
    '[config] ENCRYPTION_KEY should be at least 32 characters for production use.',
  );
}

module.exports = config;
