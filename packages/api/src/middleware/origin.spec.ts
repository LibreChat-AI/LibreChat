import express from 'express';
import request from 'supertest';
import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import { createSameOriginGuard } from './origin';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const HOST = 'chat.example.com';

function createApp(trustedOrigins: Array<string | undefined> = []) {
  const handler = jest.fn((_req: express.Request, res: express.Response) => {
    res.status(204).end();
  });
  const app = express();
  app.set('trust proxy', true);
  app.post('/api/auth/login', createSameOriginGuard({ trustedOrigins }), handler);
  return { app, handler };
}

describe('createSameOriginGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['same-origin', 'none'])('passes a browser request labelled %s', async (fetchSite) => {
    const { app, handler } = createApp();

    await request(app)
      .post('/api/auth/login')
      .set('Host', HOST)
      .set('Sec-Fetch-Site', fetchSite)
      .expect(204);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['cross-site', 'same-site'])(
    'rejects a browser request labelled %s from an untrusted origin',
    async (fetchSite) => {
      const { app, handler } = createApp(['https://chat.example.com']);

      const response = await request(app)
        .post('/api/auth/login')
        .set('Host', HOST)
        .set('Sec-Fetch-Site', fetchSite)
        .set('Origin', 'https://other-site.example.com')
        .type('form')
        .send({ email: 'other@example.com', password: 'secret' })
        .expect(403);

      expect(response.body).toEqual({
        message: 'Cross-site request rejected',
        code: ErrorTypes.AUTH_CROSS_ORIGIN,
      });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        '[requireSameOrigin] Rejected cross-site request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/auth/login',
          fetch_site: fetchSite,
          origin: 'https://other-site.example.com',
        }),
      );
    },
  );

  it('passes a cross-origin request from a trusted origin', async () => {
    const { app, handler } = createApp(['https://client.example.com/app/', undefined]);

    await request(app)
      .post('/api/auth/login')
      .set('Host', HOST)
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', 'https://client.example.com')
      .expect(204);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // Node's HTTP parser strips control characters before they reach Express, so the guard is
  // driven directly here to prove the log-sanitization branch neutralizes them anyway.
  it('strips control characters from request-derived values before logging', () => {
    const guard = createSameOriginGuard({ trustedOrigins: [] });
    const headers: Record<string, string> = {
      origin: 'https://evil.example.com\r\ninjected: 1',
      'sec-fetch-site': 'cross-site',
      host: HOST,
    };
    const req = {
      method: 'POST',
      baseUrl: '/api/auth',
      path: `/login\r\n${String.fromCharCode(0)}`,
      get: (name: string) => headers[name.toLowerCase()],
    } as unknown as express.Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as express.Response;
    const next = jest.fn();

    guard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const logged = (logger.warn as jest.Mock).mock.calls[0][1];
    for (const field of [logged.origin, logged.path, logged.fetch_site] as string[]) {
      for (const code of [13, 10, 0]) {
        expect(field).not.toContain(String.fromCharCode(code));
      }
    }
    expect(logged.origin).toContain('__injected');
  });

  it('passes a request without browser fetch metadata or an Origin, such as a server-side call', async () => {
    const { app, handler } = createApp();

    await request(app).post('/api/auth/login').set('Host', HOST).expect(204);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe('browsers that send Origin without Sec-Fetch-Site', () => {
    it('passes an Origin matching the scheme and Host the request was sent to', async () => {
      const { app, handler } = createApp();

      await request(app)
        .post('/api/auth/login')
        .set('Host', `${HOST}:443`)
        .set('X-Forwarded-Proto', 'https')
        .set('Origin', `https://${HOST}`)
        .expect(204);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rejects an http Origin on the same host as an https request', async () => {
      const { app, handler } = createApp();

      await request(app)
        .post('/api/auth/login')
        .set('Host', HOST)
        .set('X-Forwarded-Proto', 'https')
        .set('Origin', `http://${HOST}`)
        .expect(403);

      expect(handler).not.toHaveBeenCalled();
    });

    it.each(['https://other-site.example.com', 'null', 'not a url'])(
      'rejects Origin %s',
      async (origin) => {
        const { app, handler } = createApp();

        await request(app)
          .post('/api/auth/login')
          .set('Host', HOST)
          .set('Origin', origin)
          .expect(403);

        expect(handler).not.toHaveBeenCalled();
      },
    );

    it('rejects an Origin on another port of the same host', async () => {
      const { app, handler } = createApp();

      await request(app)
        .post('/api/auth/login')
        .set('Host', HOST)
        .set('X-Forwarded-Proto', 'https')
        .set('Origin', `https://${HOST}:8443`)
        .expect(403);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
