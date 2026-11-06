import express from 'express';
import request from 'supertest';
import {
  BACKCHANNEL_LOGOUT_PATH,
  excludeBackchannelLogoutBodyParser,
  createLogoutBodyParser,
} from './bodyParser';

describe('excludeBackchannelLogoutBodyParser', () => {
  function buildApp() {
    const app = express();
    const innerParser = jest.fn<void, [express.Request, express.Response, express.NextFunction]>(
      (_req, _res, next) => next(),
    );
    app.use(excludeBackchannelLogoutBodyParser(innerParser));
    app.use((req, res) => {
      res.status(200).json({ path: req.path });
    });
    return { app, innerParser };
  }

  it('skips the wrapped parser for the exact logout path', async () => {
    const { app, innerParser } = buildApp();
    await request(app).post(BACKCHANNEL_LOGOUT_PATH).send();
    expect(innerParser).not.toHaveBeenCalled();
  });

  it('skips the wrapped parser case-insensitively', async () => {
    const { app, innerParser } = buildApp();
    await request(app).post(BACKCHANNEL_LOGOUT_PATH.toUpperCase()).send();
    expect(innerParser).not.toHaveBeenCalled();
  });

  it('skips the wrapped parser with an optional trailing slash', async () => {
    const { app, innerParser } = buildApp();
    await request(app).post(`${BACKCHANNEL_LOGOUT_PATH}/`).send();
    expect(innerParser).not.toHaveBeenCalled();
  });

  it('runs the wrapped parser for any other path', async () => {
    const { app, innerParser } = buildApp();
    await request(app).post('/oauth/openid/callback').send();
    expect(innerParser).toHaveBeenCalled();
  });
});

describe('createLogoutBodyParser', () => {
  function buildApp(maxBodyBytes: number) {
    const app = express();
    const parser = createLogoutBodyParser(() => maxBodyBytes);
    app.use(parser);
    app.use((req, res) => {
      res.status(200).json({ body: req.body });
    });
    return app;
  }

  it('parses a body within the limit and calls next', async () => {
    const app = buildApp(1024);
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=abc');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ body: { logout_token: 'abc' } });
  });

  it('maps an over-limit body to 413 invalid_request', async () => {
    const app = buildApp(8);
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send(`logout_token=${'a'.repeat(100)}`);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('maps an unsupported charset to 400 invalid_request, not 413', async () => {
    const app = buildApp(1024);
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .set('Content-Type', 'application/x-www-form-urlencoded; charset=unsupported-9')
      .send('logout_token=abc');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('reuses the cached parser for the same limit across requests', async () => {
    const app = buildApp(1024);
    await request(app).post('/oauth/openid/backchannel-logout').type('form').send('a=1');
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('a=2');

    expect(response.status).toBe(200);
  });
});
