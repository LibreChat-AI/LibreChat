const express = require('express');
const request = require('supertest');
const { getTenantId } = require('@librechat/data-schemas');

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) =>
    req.get('authorization') === 'Bearer admin' ? next() : res.sendStatus(401),
  requireSameOrigin: require('@librechat/api').createSameOriginGuard({
    trustedOrigins: ['https://chat.example'],
  }),
}));
jest.mock('~/server/middleware/limiters', () => ({
  loginLimiter: (_req, _res, next) => next(),
}));
jest.mock(
  '~/server/services/DiscordManagement',
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

jest.mock('~/server/services/DiscordChannels', () => ({
  bindings: {
    status: (_req, res) => res.sendStatus(204),
    bind: (_req, res) => res.sendStatus(204),
    remove: (_req, res) => res.sendStatus(204),
  },
  routes: {
    security: (_req, res) => res.sendStatus(401),
    resolve: (_req, res) => res.sendStatus(401),
  },
  inbox: Object.fromEntries(
    ['submit', 'claim', 'finish', 'defer'].map((name) => [
      name,
      (_req, res) => res.sendStatus(401),
    ]),
  ),
}));

const savedTrust = process.env.TRUST_TENANT_HEADER;
afterEach(() => {
  if (savedTrust == null) delete process.env.TRUST_TENANT_HEADER;
  else process.env.TRUST_TENANT_HEADER = savedTrust;
});
function server() {
  const app = express();
  app.use('/api/channels/discord', require('../discord'));
  return app;
}
it.each([true, false])(
  'actual Discord callback router respects trusted tenant headers (%s)',
  async (trusted) => {
    process.env.TRUST_TENANT_HEADER = String(trusted);
    const response = await request(server())
      .get('/api/channels/discord/oauth/callback')
      .set('x-tenant-id', 'org-b')
      .expect(200);
    expect(response.body.tenantId).toBe(trusted ? 'org-b' : null);
    expect(getTenantId()).toBeUndefined();
  },
);
it.each([
  ['put', '/apps'],
  ['put', '/agents/agent/binding'],
  ['delete', '/agents/agent/binding'],
  ['post', '/connect'],
  ['delete', '/attempts/flow'],
  ['delete', '/guilds/installation'],
])('actual Discord %s %s requires JWT and same-origin writes', async (method, path) => {
  const app = server();
  const target = `/api/channels/discord${path}`;
  await request(app)[method](target).expect(401);
  await request(app)
    [method](target)
    .set('Authorization', 'Bearer admin')
    .set('Origin', 'https://attacker.example')
    .set('Sec-Fetch-Site', 'cross-site')
    .expect(403);
  const response = await request(app)
    [method](target)
    .set('Authorization', 'Bearer admin')
    .set('Origin', 'https://chat.example')
    .expect(204);
  expect(response.status).toBe(204);
});
