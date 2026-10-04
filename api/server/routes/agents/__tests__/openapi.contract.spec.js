const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, tenantStorage } = require('@librechat/data-schemas');
const {
  EModelEndpoint,
  EToolResources,
  PermissionTypes,
  Permissions,
  SystemRoles,
} = require('librechat-data-provider');
const {
  ErrorController,
  createAgentManagementAuth,
  createAgentManagementFileHandlers,
  createAgentManagementUploadResponse,
  createAgentUploadLock,
  createSkillManagementHandlers,
  handleJsonParseError,
  restoreTenantContextFromReq,
} = require('@librechat/api');
const { createMulterInstance } = require('~/server/routes/files/multer');

jest.mock('~/server/services/Config', () => ({
  checkCapability: jest.fn().mockResolvedValue(true),
}));

const specPath = path.resolve(__dirname, '../../../../../packages/api/openapi/agents.openapi.json');
const tenantId = 'openapi-contract-tenant';
const clientId = 'openapi-contract-client';
const subject = `${clientId}@clients`;
const audience = 'openapi-contract-audience';
let skillId;

function pointerEscape(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function findOperation(spec, operationId) {
  for (const [routePath, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation.operationId === operationId) return { method, operation, routePath };
    }
  }
  throw new Error(`Missing OpenAPI operation ${operationId}`);
}

function expectResponseToMatchSpec(spec, operationId, response) {
  const { method, routePath } = findOperation(spec, operationId);
  const mediaType = response.headers['content-type'].split(';', 1)[0];
  const responseContract = spec.paths[routePath][method].responses[String(response.status)];
  const schema = responseContract?.content?.[mediaType]?.schema;
  expect(schema).toBeDefined();

  const schemaPointer = [
    'paths',
    routePath,
    method,
    'responses',
    String(response.status),
    'content',
    mediaType,
    'schema',
  ]
    .map(pointerEscape)
    .join('/');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile({ ...spec, $ref: `#/${schemaPointer}` });
  const payload = mediaType === 'application/json' ? response.body : response.text;
  const valid = validate(payload);
  expect({ errors: validate.errors, valid }).toEqual({ errors: null, valid: true });
}

describe('Agents OpenAPI actual HTTP contract', () => {
  jest.setTimeout(120000);

  let app;
  let db;
  let fixtureRoot;
  let jwksServer;
  let mongoServer;
  let spec;
  let token;
  let wrongAudienceToken;
  let user;
  let agent;
  let originalUploadsPath;

  beforeAll(async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-openapi-contract-'));
    const uploadsPath = path.join(fixtureRoot, 'uploads');
    fs.mkdirSync(uploadsPath, { recursive: true });
    const configuredPaths = require('~/config/paths');
    originalUploadsPath = configuredPaths.uploads;
    configuredPaths.uploads = uploadsPath;

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    db = require('~/models');

    user = await mongoose.models.User.create({
      email: 'openapi-contract@example.test',
      name: 'OpenAPI Contract Principal',
      username: 'openapi-contract',
      provider: 'local',
      role: SystemRoles.ADMIN,
      emailVerified: true,
      tenantId,
    });
    agent = await tenantStorage.run({ tenantId }, () =>
      db.createAgent({
        id: crypto.randomUUID(),
        name: 'OpenAPI Contract Agent',
        provider: EModelEndpoint.openAI,
        model: 'gpt-5',
        author: user._id,
        tenantId,
      }),
    );
    const createdSkill = await tenantStorage.run({ tenantId }, () =>
      db.createSkill({
        name: 'openapi-contract-skill',
        displayTitle: 'OpenAPI Contract Skill',
        description: 'Disposable skill used to verify the public HTTP contract.',
        body: '# OpenAPI Contract Skill',
        author: user._id,
        authorName: user.name,
        tenantId,
      }),
    );
    skillId = createdSkill.skill._id;

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyId = 'openapi-contract-key';
    const jwk = publicKey.export({ format: 'jwk' });
    Object.assign(jwk, { alg: 'RS256', kid: keyId, use: 'sig' });
    jwksServer = http.createServer((req, res) => {
      if (req.url !== '/jwks.json') {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const issuer = `http://127.0.0.1:${jwksServer.address().port}`;
    token = jwt.sign({ azp: clientId }, privateKey, {
      algorithm: 'RS256',
      audience,
      expiresIn: '5m',
      issuer,
      keyid: keyId,
      subject,
    });
    wrongAudienceToken = jwt.sign({ azp: clientId }, privateKey, {
      algorithm: 'RS256',
      audience: 'wrong-audience',
      expiresIn: '5m',
      issuer,
      keyid: keyId,
      subject,
    });

    const appConfig = {
      fileStrategy: 'local',
      paths: { uploads: uploadsPath },
      fileConfig: {},
      endpoints: {
        agents: {
          managementApi: {
            auth: {
              oidc: { enabled: true, issuer, audience, jwksUri: `${issuer}/jwks.json` },
              clients: [
                {
                  clientId,
                  subject,
                  userId: user._id.toString(),
                  tenantId,
                },
              ],
            },
          },
        },
      },
    };
    const auth = createAgentManagementAuth({
      findUser: (filter) => mongoose.models.User.findOne(filter),
      getAppConfig: async () => appConfig,
      isPrincipalActive: async () => true,
    });
    const getRoleByName = async () => ({
      name: SystemRoles.ADMIN,
      permissions: {
        [PermissionTypes.AGENTS]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
        [PermissionTypes.SKILLS]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
      },
    });

    const { processAgentFileUpload } = require('~/server/services/Files/process');
    const fileHandlers = createAgentManagementFileHandlers({
      getRoleByName,
      getAgentWithVersionCount: db.getAgentWithVersionCount,
      getFiles: db.getFiles,
      checkPermission: async () => true,
      hasCapability: async () => true,
      removeAgentResourceFiles: db.removeAgentResourceFiles,
      processUpload: (req, res) =>
        processAgentFileUpload({
          req,
          res: createAgentManagementUploadResponse(res, req.file, req.body.tool_resource),
          metadata: { ...req.body, file_id: req.file_id },
        }),
      deleteTempFile: fs.promises.unlink,
      getUploadConfig: async () => ({
        endpoint: EModelEndpoint.openAI,
        endpointType: EModelEndpoint.openAI,
        disabled: false,
        fileSizeLimit: 1024 * 1024,
        fileLimit: 5,
        totalSizeLimit: 5 * 1024 * 1024,
      }),
      isUploadPurposeEnabled: async () => true,
      runUploadExclusive: createAgentUploadLock({ redisClient: null }),
    });
    const multipart = await createMulterInstance({
      fileConfig: appConfig.fileConfig,
      resolveEndpoint: fileHandlers.getUploadConfig,
      uniqueTempPath: true,
    });

    const { getSkillManagementFileSaver } = require('~/server/services/Endpoints/agents/skillDeps');
    const skillHandlers = createSkillManagementHandlers({
      handlers: {},
      getSkillById: db.getSkillById,
      getRoleByName,
      checkPermission: async () => true,
      hasCapability: async () => true,
      saveFile: getSkillManagementFileSaver(),
    });

    app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use(handleJsonParseError);
    app.use('/api/agents/v1', auth, (req, _res, next) => {
      req.config = appConfig;
      next();
    });
    app.post(
      '/api/agents/v1/agents/:id/files',
      fileHandlers.authorizeUpload,
      multipart.single('file'),
      restoreTenantContextFromReq,
      fileHandlers.upload,
    );
    app.put('/api/agents/v1/skills/:id/files/*relativePath', skillHandlers.updateFile);
    app.get('/api/agents/v1/agents/:id', (_req, _res, next) =>
      next(new Error('contract fixture escaped error')),
    );
    app.use(ErrorController);

    spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  });

  afterAll(async () => {
    if (jwksServer) await new Promise((resolve) => jwksServer.close(resolve));
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
    require('~/config/paths').uploads = originalUploadsPath;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('documents and validates the real OIDC authentication rejection', async () => {
    const missing = await request(app).get(`/api/agents/v1/agents/${agent.id}`);
    const invalid = await request(app)
      .get(`/api/agents/v1/agents/${agent.id}`)
      .set('Authorization', `Bearer ${wrongAudienceToken}`);

    for (const response of [missing, invalid]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
      expectResponseToMatchSpec(spec, 'getAgent', response);
    }
  });

  it('documents and validates a multipart upload persisted by the Agent upload pipeline', async () => {
    const content = 'actual HTTP upload contract\n';
    const response = await request(app)
      .post(`/api/agents/v1/agents/${agent.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('purpose', EToolResources.context)
      .attach('file', Buffer.from(content), {
        filename: 'contract.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(200);
    expectResponseToMatchSpec(spec, 'uploadAgentFile', response);
    const persisted = await mongoose.models.File.findOne({
      file_id: response.body.id,
      tenantId,
    }).lean();
    expect(persisted).toMatchObject({
      bytes: Buffer.byteLength(content),
      filename: 'contract.txt',
      tenantId,
      text: content,
      type: 'text/plain',
    });
    const persistedAgent = await mongoose.models.Agent.findOne({ id: agent.id, tenantId }).lean();
    expect(persistedAgent.tool_resources.context.file_ids).toContain(response.body.id);
  });

  it('documents and validates a skill-file write with Mongo and disk readback', async () => {
    const initialContent = '# Contract reference\nCreated through the production skill writer.\n';
    const content = '# Contract reference\nOverwritten through the production skill writer.\n';
    const relativePath = 'references/contract.md';
    const created = await request(app)
      .put(`/api/agents/v1/skills/${skillId}/files/references/contract.md`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: initialContent });
    const updated = await request(app)
      .put(`/api/agents/v1/skills/${skillId}/files/references/contract.md`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content });

    expect(created.status).toBe(200);
    expect(updated.status).toBe(200);
    expectResponseToMatchSpec(spec, 'updateSkillFile', created);
    expectResponseToMatchSpec(spec, 'updateSkillFile', updated);
    const persisted = await mongoose.models.SkillFile.findOne({ skillId, relativePath }).lean();
    expect(persisted).toMatchObject({
      bytes: Buffer.byteLength(content),
      mimeType: 'text/plain',
      relativePath,
      tenantId,
    });
    const diskPath = path.join(
      require('~/config/paths').uploads,
      user._id.toString(),
      path.basename(persisted.filepath),
    );
    expect(fs.readFileSync(diskPath, 'utf8')).toBe(content);
  });

  it('validates parser and normalized management errors against their documented JSON forms', async () => {
    const malformed = await request(app)
      .put(`/api/agents/v1/skills/${skillId}/files/contract.md`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send('{');
    const invalid = await request(app)
      .put(`/api/agents/v1/skills/${skillId}/files/contract.md`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'valid', extra: true });
    const oversizedUtf8 = await request(app)
      .put(`/api/agents/v1/skills/${skillId}/files/contract.md`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'é'.repeat(512 * 1024 + 1) });

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(oversizedUtf8.status).toBe(400);
    expectResponseToMatchSpec(spec, 'updateSkillFile', malformed);
    expectResponseToMatchSpec(spec, 'updateSkillFile', invalid);
    expectResponseToMatchSpec(spec, 'updateSkillFile', oversizedUtf8);
  });

  it('records the global JSON size-limit response before authentication', async () => {
    const response = await request(app)
      .put(`/api/agents/v1/skills/${skillId}/files/contract.md`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ content: 'x'.repeat(3 * 1024 * 1024 + 1) }));

    expect(response.status).toBe(500);
    expect(response.text).toBe('An unknown error occurred.');
    expectResponseToMatchSpec(spec, 'updateSkillFile', response);
  });

  it('documents the final error controller string response with its actual text/html type', async () => {
    const response = await request(app)
      .get(`/api/agents/v1/agents/${agent.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(500);
    expect(response.text).toBe('An unknown error occurred.');
    expectResponseToMatchSpec(spec, 'getAgent', response);
  });
});
