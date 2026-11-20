'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db');
const v1Routes = require('./routes/v1');

db.initDb();

const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, lcBaseUrl: config.lcBaseUrl });
});

app.use('/integration/v1', v1Routes);

if (config.gatewayAdminToken) {
  const adminRoutes = require('./routes/admin');
  app.use('/integration/admin/v1', adminRoutes);
  console.info('[integration-gateway] Admin API mounted at /integration/admin/v1');
} else {
  console.info('[integration-gateway] GATEWAY_ADMIN_TOKEN not set — Admin API disabled');
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(config.port, () => {
  console.info(`[integration-gateway] listening on :${config.port}`);
  console.info(`[integration-gateway] LibreChat base URL: ${config.lcBaseUrl}`);
  console.info(
    `[integration-gateway] Demo client id: ${config.demoClientId} (see integration-gateway/.env.example)`,
  );
});
