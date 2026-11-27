/**
 * Loads the real route against the real packages. Only the app's own singletons are stood in
 * for, so a dependency the handlers need and the route does not pass fails here.
 */
const express = require('express');
const request = require('supertest');
const { PermissionTypes, Permissions } = require('librechat-data-provider');

jest.mock('~/models', () => ({ getRoleByName: jest.fn() }));
jest.mock('~/server/services/Schedules/access', () => ({ resolveAgentFireAccess: jest.fn() }));
jest.mock('~/server/services/Events/subject', () => ({ service: {} }));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'owner', role: 'USER' };
    next();
  },
}));

const { getRoleByName } = require('~/models');
const router = require('../events');

const app = express();
app.use(express.json());
app.use('/api/agents/events', router);

const reads = [
  ['get', '/connections'],
  ['get', '/subscriptions'],
  ['delete', '/subscriptions/sub_1'],
  ['get', '/subscriptions/sub_1/grant'],
  ['delete', '/subscriptions/sub_1/grant'],
];
const writes = [
  ['post', '/subscriptions'],
  ['patch', '/subscriptions/sub_1'],
  ['post', '/subscriptions/sub_1/grant'],
];
const role = (permissions) => getRoleByName.mockResolvedValue({ permissions });

describe('agent event routes', () => {
  it.each([...reads, ...writes])(
    '%s %s is refused to a role without agent events',
    async (method, path) => {
      role({});
      const res = await request(app)[method](`/api/agents/events${path}`).send({});
      expect(res.status).toBe(403);
    },
  );

  it.each(writes)('%s %s is refused to a role that may only use them', async (method, path) => {
    role({ [PermissionTypes.AGENT_EVENTS]: { [Permissions.USE]: true } });
    const res = await request(app)[method](`/api/agents/events${path}`).send({});
    expect(res.status).toBe(403);
  });

  it('reaches the handler for a role that may create, which then checks the body', async () => {
    role({
      [PermissionTypes.AGENT_EVENTS]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
    });
    const res = await request(app).post('/api/agents/events/subscriptions').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'subscription_invalid' });
  });
});
