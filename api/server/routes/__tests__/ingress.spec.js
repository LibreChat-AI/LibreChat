/**
 * Loads the real ingress route against the real packages. Only the app's own singletons are
 * stood in for, so a dependency the handler needs and the route does not pass fails here.
 */
const express = require('express');
const request = require('supertest');

jest.mock('~/server/services/Agents/triggers', () => ({ enqueueAgentTrigger: jest.fn() }));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));

const { getAppConfig } = require('~/server/services/Config/app');
const router = require('../ingress');

const app = express();
app.use('/api/agents/events/in', router);

describe('agent event ingress route', () => {
  beforeEach(() => {
    getAppConfig.mockReset();
  });

  it('answers 404 with no session while events are off, reading the base config only', async () => {
    getAppConfig.mockResolvedValue({ endpoints: { agents: {} } });
    const res = await request(app)
      .post('/api/agents/events/in/github')
      .set('content-type', 'application/json')
      .send('{"action":"submitted"}');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('refuses an unsigned delivery once events are on', async () => {
    getAppConfig.mockResolvedValue({
      endpoints: {
        agents: {
          events: {
            enabled: true,
            github: {
              appId: '${INGRESS_SPEC_APP_ID}',
              privateKey: '${INGRESS_SPEC_KEY}',
              webhookSecret: '${INGRESS_SPEC_SECRET}',
            },
          },
        },
      },
    });
    process.env.INGRESS_SPEC_APP_ID = '1';
    process.env.INGRESS_SPEC_KEY = 'not-a-real-key';
    process.env.INGRESS_SPEC_SECRET = 'spec-secret';
    try {
      const res = await request(app)
        .post('/api/agents/events/in/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'pull_request_review')
        .send('{"action":"submitted"}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'signature' });
    } finally {
      delete process.env.INGRESS_SPEC_APP_ID;
      delete process.env.INGRESS_SPEC_KEY;
      delete process.env.INGRESS_SPEC_SECRET;
    }
  });

  it('takes only POST', async () => {
    getAppConfig.mockResolvedValue({ endpoints: { agents: {} } });
    const res = await request(app).get('/api/agents/events/in/github');
    expect(res.status).toBe(404);
  });
});
