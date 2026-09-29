const express = require('express');
const request = require('supertest');

const mockModels = jest.fn((req, res) => res.json({ model: req.config.model }));

jest.mock('~/server/middleware/', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = { model: 'current-model' };
  next();
});

jest.mock('~/server/controllers/ModelController', () => ({
  modelController: (...args) => mockModels(...args),
}));

const models = require('./models');

describe('model route with dev config middleware', () => {
  it('registers a request-scoped config reader and serves models', async () => {
    const app = express();
    app.use('/api/models', models);

    const response = await request(app).get('/api/models');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ model: 'current-model' });
    expect(mockModels).toHaveBeenCalledTimes(1);
  });
});
