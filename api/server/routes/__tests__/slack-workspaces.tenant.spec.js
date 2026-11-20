const express = require('express');
const request = require('supertest');
const { getTenantId } = require('@librechat/data-schemas');

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
  requireSameOrigin: (_req, _res, next) => next(),
}));
jest.mock('~/server/middleware/limiters', () => ({
  loginLimiter: (_req, _res, next) => next(),
}));
jest.mock(
  '~/server/services/SlackWorkspaces',
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) =>
          name === 'callback'
            ? (_req, res) =>
                res.json({ tenantId: require('@librechat/data-schemas').getTenantId() ?? null })
            : (_req, res) => res.sendStatus(204),
      },
    ),
);

const savedTrust = process.env.TRUST_TENANT_HEADER;
afterEach(() => {
  if (savedTrust == null) delete process.env.TRUST_TENANT_HEADER;
  else process.env.TRUST_TENANT_HEADER = savedTrust;
});

test.each([true, false])(
  'actual Slack callback router honors trusted tenant headers only when enabled (%s)',
  async (trusted) => {
    process.env.TRUST_TENANT_HEADER = String(trusted);
    const app = express();
    app.use('/api/channels', require('../slack-workspaces'));
    const response = await request(app)
      .get('/api/channels/workspaces/oauth/callback')
      .set('x-tenant-id', 'org-b')
      .expect(200);
    expect(response.body.tenantId).toBe(trusted ? 'org-b' : null);
    expect(getTenantId()).toBeUndefined();
  },
);
