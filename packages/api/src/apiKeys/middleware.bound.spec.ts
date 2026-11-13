import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { ApiKeyAuthRequest } from './middleware';
import { createRequireApiKeyAuth } from './middleware';

let mongo: MongoMemoryReplSet;
let methods: ReturnType<typeof createMethods>;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('keeps ordinary HTTP authentication working while bound grants require their separate validator', async () => {
  const user = await mongoose.models.User.create({
    email: 'key-owner@example.com',
    provider: 'openid',
  });
  const userId = String(user._id);
  const ordinary = await methods.createAgentApiKey({ userId, name: 'ordinary' });
  const binding = { kind: 'grant', id: 'source-authority' };
  const bound = await methods.createAgentApiKey({ userId, name: 'bound', binding });
  const app = express();
  const authenticate = createRequireApiKeyAuth({
    validateAgentApiKey: methods.validateAgentApiKey,
    findUser: methods.findUser,
    isPrincipalActive: methods.isAgentTriggerPrincipalActive,
  });
  app.get(
    '/',
    async (req, res, next) => {
      await authenticate(req as ApiKeyAuthRequest, res, next);
    },
    (_req, res) => {
      res.status(200).end();
    },
  );

  expect((await request(app).get('/').auth(ordinary.key, { type: 'bearer' })).status).toBe(200);
  const rejected = await request(app).get('/').auth(bound.key, { type: 'bearer' });
  expect(rejected.status).toBe(401);
  expect(rejected.body.error.code).toBe('invalid_api_key');
  expect(await methods.validateBoundAgentApiKey(bound.key)).toMatchObject({ binding });
  expect(await methods.validateBoundAgentApiKey(ordinary.key)).toBeNull();
});
