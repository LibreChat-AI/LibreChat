import express from 'express';
import request from 'supertest';
import mongoSanitize from 'express-mongo-sanitize';
import type { Request, Response, NextFunction } from 'express';
import { createRequestSanitizer, rejectUnsafeConfigKeys } from './sanitize';

type Echo = { body: unknown; query: unknown; headers: Record<string, unknown> };

/** The app-level order in `api/server/index.js`: JSON body, writable query, then the sanitizer. */
function createApp(...guards: Array<(req: Request, res: Response, next: NextFunction) => void>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });
  app.use(createRequestSanitizer(mongoSanitize));
  app.use(...guards, (req: Request, res: Response) => {
    res.json({ body: req.body, query: req.query, headers: req.headers });
  });
  return app;
}

async function send(app: express.Express, path: string, body: unknown, query = '') {
  const response = await request(app)
    .patch(`${path}${query}`)
    .set('x-test.dotted', 'h')
    .set('$x-test', 'h')
    .send(body as object);
  return { status: response.status, echo: response.body as Echo };
}

const DOTTED_BODY = {
  entries: [
    {
      fieldPath: 'endpoints.bedrock.inferenceProfiles',
      value: { 'us.anthropic.claude-sonnet-4-6': 'arn:aws:bedrock:us-east-1:1:x' },
    },
  ],
};

describe('createRequestSanitizer', () => {
  const app = createApp();

  it.each([
    '/api/admin/config/role/__base__/fields',
    '/API/Admin/Config/role/__base__/fields',
    '/api/admin/config',
  ])('keeps dotted body keys on %s', async (path) => {
    const { status, echo } = await send(app, path, DOTTED_BODY);
    expect(status).toBe(200);
    expect(echo.body).toEqual(DOTTED_BODY);
  });

  it('keeps query and headers strict on the admin config path', async () => {
    const { echo } = await send(
      app,
      '/api/admin/config/role/x/fields',
      DOTTED_BODY,
      '?a.b=1&$where=1&ok=1',
    );
    expect(echo.query).toEqual({ ok: '1' });
    expect(echo.headers).not.toHaveProperty('x-test.dotted');
    expect(echo.headers).not.toHaveProperty('$x-test');
  });

  it.each([
    '/api/admin/configs',
    '/api/admin/configuration',
    '/api/admin/roles',
    '/api/agents',
    '/api/admin/%63onfig/role/x/fields',
  ])('still strips dotted and $ keys from the body on %s', async (path) => {
    const { echo } = await send(app, path, {
      entries: [{ fieldPath: 'x', value: { 'a.b': 1, $where: 'x', kept: 1 } }],
    });
    expect(echo.body).toEqual({ entries: [{ fieldPath: 'x', value: { kept: 1 } }] });
  });
});

describe('rejectUnsafeConfigKeys', () => {
  const app = createApp(rejectUnsafeConfigKeys);

  it.each([
    ['a $ operator', '{"entries":[{"fieldPath":"x","value":{"$where":"1"}}]}'],
    ['a nested $ key in an array', '{"overrides":{"a":[{"b":[{"$set":1}]}]}}'],
    ['a __proto__ key', '{"overrides":{"registration":{"__proto__":{"polluted":true}}}}'],
    ['a constructor key', '{"overrides":{"constructor":{"prototype":{}}}}'],
  ])('answers 400 CONFIG_UNSAFE_KEY for %s without echoing it', async (_label, raw) => {
    const response = await request(app)
      .patch('/api/admin/config/role/x/fields')
      .set('content-type', 'application/json')
      .send(raw);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Config keys cannot start with "$" or name an object prototype',
      code: 'CONFIG_UNSAFE_KEY',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('passes dotted keys, `$` inside values, and bodies without objects through', async () => {
    const body = { entries: [{ fieldPath: 'a.b', value: { 'gpt-4.1': '$5 per run', n: [1] } }] };
    const { status, echo } = await send(app, '/api/admin/config/role/x/fields', body);
    expect(status).toBe(200);
    expect(echo.body).toEqual(body);

    const empty = await request(app).delete('/api/admin/config/role/x/fields?fieldPath=a');
    expect(empty.status).toBe(200);
  });
});
