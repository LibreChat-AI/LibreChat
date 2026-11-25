const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, logger } = require('@librechat/data-schemas');
const jwtStrategy = require('~/strategies/jwtStrategy');
const bannerRoute = require('../banner');

const banner = { bannerId: 'maintenance', message: 'Routine maintenance' };
const activeSince = new Date('2020-01-01T00:00:00.000Z');

let mongo;
let app;
let token;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { dbName: 'banner-contract' } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  const user = await mongoose.models.User.create({
    email: 'banner-viewer@example.test',
    provider: 'local',
    role: 'USER',
  });
  token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  passport.use('jwt', jwtStrategy());
  app = express();
  app.use(passport.initialize());
  app.use('/api/banner', bannerRoute);
});

afterEach(async () => {
  await mongoose.models.Banner.deleteMany({});
  jest.restoreAllMocks();
});

afterAll(async () => {
  passport.unuse('jwt');
  await mongoose.disconnect();
  await mongo?.stop();
});

it.each([true, false, undefined])(
  'returns only the public display fields (persistable=%s)',
  async (value) => {
    await mongoose.models.Banner.collection.insertOne({
      ...banner,
      displayFrom: activeSince,
      isPublic: true,
      type: 'banner',
      ...(value === undefined ? {} : { persistable: value }),
    });

    const response = await request(app).get('/api/banner');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...banner, persistable: value ?? false });
  },
);

it('shows a signed-in banner to a signed-in viewer', async () => {
  await mongoose.models.Banner.create({ ...banner, displayFrom: activeSince, isPublic: false });

  const anonymous = await request(app).get('/api/banner');
  const authenticated = await request(app)
    .get('/api/banner')
    .set('Authorization', `Bearer ${token}`);

  expect(anonymous.status).toBe(200);
  expect(anonymous.text).toBe('');
  expect(authenticated.status).toBe(200);
  expect(authenticated.body).toEqual({ ...banner, persistable: false });
});

it('keeps the empty response when no active banner exists', async () => {
  const response = await request(app).get('/api/banner');

  expect(response.status).toBe(200);
  expect(response.text).toBe('');
});

it('logs lookup errors and returns the existing error response', async () => {
  jest.spyOn(mongoose.models.Banner, 'findOne').mockImplementationOnce(() => {
    throw new Error('Banner lookup unavailable');
  });

  const response = await request(app).get('/api/banner');

  expect(response.status).toBe(500);
  expect(response.body).toEqual({ message: 'Error getting banner' });
  expect(logger.error).toHaveBeenCalledWith('[getBanner] Error getting banner', expect.any(Error));
});
