const express = require('express');
const passport = require('passport');
const request = require('supertest');

jest.mock('passport', () => ({ authenticate: jest.fn() }));
jest.mock('@librechat/api', () => jest.requireActual('../../../packages/api/src/middleware/ldap'));

const requireLdapAuth = require('./requireLdapAuth');

let app;
let bind;
beforeEach(() => {
  jest.clearAllMocks();
  bind = jest.fn();
  passport.authenticate.mockImplementation((_strategy, callback) => (req) => {
    bind(req.body);
    callback(null, { id: 'ldap-user' });
  });
  app = express();
  app.use(express.json());
  app.post('/login', requireLdapAuth, (req, res) => res.json({ id: req.user.id }));
  app.use((_error, _req, res, _next) => res.sendStatus(500));
});

describe.each(['email', 'password'])('LDAP %s validation', (field) => {
  it.each([undefined, null, {}, [], 123, 0, true, false, ''])(
    'rejects malformed credentials before invoking Passport: %p',
    async (value) => {
      const response = await request(app)
        .post('/login')
        .send({ email: 'alice', password: 'fixture-secret', [field]: value });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: 'Invalid credentials' });
      expect(passport.authenticate).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
    },
  );
});

it('rejects a missing body before invoking Passport', async () => {
  expect((await request(app).post('/login')).status).toBe(400);
  expect(passport.authenticate).not.toHaveBeenCalled();
});

it.each(['alice', 'DOMAIN\\alice', 'alice@example.test'])(
  'preserves valid LDAP identifiers and passwords verbatim: %s',
  async (email) => {
    const credentials = { email, password: '  fixture secret  ' };
    const response = await request(app).post('/login').send(credentials);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'ldap-user' });
    expect(bind).toHaveBeenCalledWith(credentials);
  },
);

it('preserves ordinary authentication failure behavior', async () => {
  passport.authenticate.mockImplementation(
    (_strategy, callback) => () => callback(null, false, { message: 'Invalid username/password' }),
  );
  const response = await request(app)
    .post('/login')
    .send({ email: 'alice', password: 'wrong-password' });
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ message: 'Invalid username/password' });
});

it('forwards operational authentication errors to the request error boundary', async () => {
  passport.authenticate.mockImplementation(
    (_strategy, callback) => () => callback(new Error('fixture LDAP outage')),
  );
  expect(
    (await request(app).post('/login').send({ email: 'alice', password: 'fixture-secret' })).status,
  ).toBe(500);
});
