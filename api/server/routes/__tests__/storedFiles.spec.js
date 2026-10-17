const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { Readable } = require('stream');
const { mockClient } = require('aws-sdk-client-mock');
const { sdkStreamMixin } = require('@smithy/util-stream');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

jest.mock('~/models', () => ({
  findSession: jest.fn(),
  getUserById: jest.fn(),
  getFiles: jest.fn(),
  getAgents: jest.fn(),
}));

jest.mock('~/server/services/PermissionService', () => ({
  getEffectivePermissions: jest.fn(),
}));

const OWNER_ID = '65cfb246f7ecadb8b1e8036b';
const OTHER_ID = '65cfb246f7ecadb8b1e8036c';
const KEY_PATH = `/api/stored-files/s3/images/${OWNER_ID}/file-1__photo.png`;

describe('stored file route', () => {
  const originalEnv = { ...process.env };
  const s3Mock = mockClient(S3Client);
  let app;
  let models;

  beforeAll(() => {
    process.env.AWS_REGION = 'eu-west-2';
    process.env.AWS_BUCKET_NAME = 'test-bucket';
    process.env.JWT_REFRESH_SECRET = 'stored-files-secret';
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    const { STORED_FILES_ROUTE } = require('@librechat/api');
    models = require('~/models');
    app = express();
    app.use(STORED_FILES_ROUTE, require('../storedFiles'));
  });

  afterAll(() => {
    process.env = originalEnv;
    s3Mock.restore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    s3Mock.reset();
    s3Mock
      .on(GetObjectCommand)
      .callsFake(() => ({ Body: sdkStreamMixin(Readable.from([Buffer.from('png')])) }));
    models.findSession.mockResolvedValue({ _id: 'session' });
    models.getUserById.mockResolvedValue({ provider: 'local', role: 'USER' });
    models.getFiles.mockResolvedValue([]);
    models.getAgents.mockResolvedValue([]);
  });

  const signedCookie = (userId) =>
    `refreshToken=${jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '1h' })}`;

  it('streams the object to the owner named in the key', async () => {
    const res = await request(app).get(KEY_PATH).set('Cookie', signedCookie(OWNER_ID));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.toString()).toBe('png');
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: `images/${OWNER_ID}/file-1__photo.png`,
    });
  });

  it('asks for a session cookie', async () => {
    expect((await request(app).get(KEY_PATH)).status).toBe(401);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('refuses a cookie whose session has ended', async () => {
    models.findSession.mockResolvedValue(null);

    const res = await request(app).get(KEY_PATH).set('Cookie', signedCookie(OWNER_ID));

    expect(res.status).toBe(403);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("does not reveal another user's file", async () => {
    const res = await request(app).get(KEY_PATH).set('Cookie', signedCookie(OTHER_ID));

    expect(res.status).toBe(404);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(models.getFiles).toHaveBeenCalledWith(
      {
        user: OWNER_ID,
        source: 's3',
        $or: [{ storageKey: `images/${OWNER_ID}/file-1__photo.png` }, { filepath: KEY_PATH }],
      },
      null,
      { text: 0 },
      1,
    );
  });

  it('serves a file attached to an agent the viewer can view', async () => {
    const { getEffectivePermissions } = require('~/server/services/PermissionService');
    models.getFiles.mockResolvedValue([{ file_id: 'file-1', user: OWNER_ID }]);
    models.getAgents.mockResolvedValue([{ _id: 'agent-db-id', id: 'agent_1', author: OWNER_ID }]);
    getEffectivePermissions.mockResolvedValue(1);

    const res = await request(app).get(KEY_PATH).set('Cookie', signedCookie(OTHER_ID));

    expect(res.status).toBe(200);
    expect(getEffectivePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OTHER_ID, role: 'USER', resourceId: 'agent-db-id' }),
    );
  });

  it('serves avatars to any signed-in user', async () => {
    const res = await request(app)
      .get(`/api/stored-files/s3/avatars/${OWNER_ID}/avatar-123.png`)
      .set('Cookie', signedCookie(OTHER_ID));

    expect(res.status).toBe(200);
    expect(models.getFiles).not.toHaveBeenCalled();
  });
});
