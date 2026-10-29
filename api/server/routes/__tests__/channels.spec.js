const express = require('express');
const request = require('supertest');
const { PermissionBits } = require('librechat-data-provider');

const mockAccess = jest.fn(() => (req, res, next) => {
  if (req.headers['x-test-share'] !== 'yes') return res.sendStatus(403);
  next();
});
jest.mock('~/server/middleware', () => ({
  canAccessAgentResource: (...args) => mockAccess(...args),
  requireJwtAuth: (req, res, next) => {
    if (req.headers['x-test-owner'] !== 'yes') return res.sendStatus(401);
    next();
  },
  requireSameOrigin: (req, res, next) => {
    if (req.headers.origin !== 'https://fixture.example') return res.sendStatus(403);
    next();
  },
}));
jest.mock('../agents/middleware', () => ({
  checkRemoteAgentsFeature: (req, res, next) => {
    if (req.headers['x-test-enabled'] !== 'yes') return res.sendStatus(403);
    next();
  },
}));
jest.mock('~/server/services/Channels', () => {
  const handler = (name) => (_req, res) => res.json({ handler: name });
  const names = [
    'admit',
    'claim',
    'stopThread',
    'renew',
    'yieldLease',
    'advance',
    'prepareResponse',
    'bindResponse',
    'cancel',
    'review',
    'submitReview',
    'plan',
    'planProgress',
    'beginProgress',
    'settleProgress',
    'begin',
    'settle',
    'checkpointUpload',
    'artifact',
    'commit',
  ];
  return {
    ...Object.fromEntries(
      ['list', 'create', 'manifest', 'update', 'remove', 'bundle', 'getThread', 'putThread'].map(
        (name) => [name, handler(name)],
      ),
    ),
    runs: Object.fromEntries(names.map((name) => [name, handler(name)])),
    identityHandlers: Object.fromEntries(
      ['inspectActor', 'issue', 'confirm', 'preview', 'accept', 'list', 'revoke'].map((name) => [
        name,
        handler(`identity.${name}`),
      ]),
    ),
    feedbackHandlers: { reaction: handler('reaction') },
  };
});

const app = express();
app.use(express.json());
app.use('/channels', require('../channels'));
app.use('/agents/:agentId/channels', require('../agents/channels'));
const accessOptions = mockAccess.mock.calls[0][0];

it.each([
  ['post', '', 'admit'],
  ['post', '/claim', 'claim'],
  ['post', '/stop-thread', 'stopThread'],
  ['post', '/run/renew', 'renew'],
  ['post', '/run/yield', 'yieldLease'],
  ['post', '/run/advance', 'advance'],
  ['post', '/run/response/prepare', 'prepareResponse'],
  ['post', '/run/response/bind', 'bindResponse'],
  ['post', '/run/cancel', 'cancel'],
  ['post', '/run/review', 'review'],
  ['post', '/run/review/decision', 'submitReview'],
  ['post', '/run/plan', 'plan'],
  ['post', '/run/progress/plan', 'planProgress'],
  ['post', '/run/progress/begin', 'beginProgress'],
  ['post', '/run/progress/settle', 'settleProgress'],
  ['post', '/run/delivery/begin', 'begin'],
  ['post', '/run/delivery/settle', 'settle'],
  ['post', '/run/delivery/checkpoint', 'checkpointUpload'],
  ['post', '/run/artifacts/artifact', 'artifact'],
  ['post', '/run/commit', 'commit'],
])('routes %s /runs%s to the guarded %s handler', async (method, suffix, handler) => {
  const result = await request(app)[method](`/channels/service/channel/runs${suffix}`).expect(200);
  expect(result.body).toEqual({ handler });
});

it('mounts feedback and service-side actor confirmation separately', async () => {
  const result = await request(app)
    .post('/channels/service/channel/reactions')
    .expect(200, { handler: 'reaction' });
  expect(result.body.handler).toBe('reaction');
  await request(app)
    .post('/channels/service/channel/identity/actor/confirm')
    .expect(200, { handler: 'identity.confirm' });
});

it('requires browser authentication and same-origin checks before link acceptance', async () => {
  const denied = await request(app).post('/channels/links/accept').expect(401);
  expect(denied.status).toBe(401);
  await request(app).post('/channels/links/accept').set('x-test-owner', 'yes').expect(403);
  await request(app)
    .post('/channels/links/accept')
    .set('x-test-owner', 'yes')
    .set('Origin', 'https://fixture.example')
    .expect(200, { handler: 'identity.accept' });
});

it('requires feature policy and Agent SHARE for management routes', async () => {
  expect(accessOptions).toEqual({
    requiredPermission: PermissionBits.SHARE,
    resourceIdParam: 'agentId',
  });
  await request(app).post('/agents/agent/channels').expect(403);
  await request(app).post('/agents/agent/channels').set('x-test-enabled', 'yes').expect(403);
  await request(app)
    .post('/agents/agent/channels')
    .set('x-test-enabled', 'yes')
    .set('x-test-share', 'yes')
    .expect(200, { handler: 'create' });
});
