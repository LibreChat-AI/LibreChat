import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { createUploadLimiters } from './uploads';

test('chat and Studio use one memory bucket and read projected YAML limits at first request', async () => {
  const environment = { FILE_UPLOAD_USER_MAX: '50', FILE_UPLOAD_USER_WINDOW: '1' };
  const logViolation = jest.fn(async () => undefined);
  const shared = createUploadLimiters({
    factory: rateLimit,
    createStore: () => undefined,
    environment,
    logViolation,
  });
  const chat = shared.createFileLimiters();
  const studio = shared.createFileLimiters({
    onLimit: (_req, res) => {
      res.status(429).json({ error: { code: 'quota_exceeded' } });
    },
  });
  environment.FILE_UPLOAD_USER_MAX = '1';
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'owner' } as Express.User;
    next();
  });
  app.post('/chat', chat.fileUploadUserLimiter, (_req, res) => {
    res.sendStatus(200);
  });
  app.post('/studio', studio.fileUploadUserLimiter, (_req, res) => {
    res.sendStatus(200);
  });
  await request(app).post('/chat').expect(200);
  await request(app)
    .post('/studio')
    .expect(429, { error: { code: 'quota_exceeded' } });
  await request(app)
    .post('/chat')
    .expect(429, { message: 'Too many file upload requests. Try again later' });
  expect(logViolation).toHaveBeenCalledTimes(2);
  expect(logViolation.mock.calls[0]).toEqual(
    expect.arrayContaining([expect.objectContaining({ max: 1, limiter: 'user' })]),
  );
});
