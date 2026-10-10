const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockDb = { methods: null };

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  countTokens: jest.fn().mockResolvedValue(10),
  applyForcedRetention: jest.fn().mockResolvedValue(undefined),
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  createPrivateTextView: jest.fn(() => (_req, _res, next) => next()),
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  GenerationJobManager: { getJob: jest.fn().mockResolvedValue(null) },
}));

jest.mock('~/models', () => {
  const methods = new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (...args) =>
          mockDb.methods[key](...args),
    },
  );
  return methods;
});

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({
    toolCallPreviews: { enabled: true, outputChars: 512, argsChars: 512 },
  }),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));

jest.mock('~/server/middleware', () => {
  const validation = jest.requireActual('~/server/middleware/messageValidation');
  return {
    ...validation,
    requireJwtAuth: (_req, _res, next) => next(),
    configMiddleware: (req, _res, next) => {
      req.config = {};
      next();
    },
  };
});

const OWNER = 'owner-user';
const OTHER = 'other-user';

const fullOutput = `stdout:\n${'compiled module\n'.repeat(3_000)}[exit code: 0]`;
const fullArgs = JSON.stringify({
  command: 'npm run build',
  intent: 'Build',
  pad: 'p'.repeat(4_000),
});
const transcript = [
  { type: 'text', text: 'child is reading' },
  {
    type: 'tool_call',
    tool_call: {
      id: 'child_1',
      name: 'read_file',
      args: '{"path":"a"}',
      output: 'z'.repeat(2_000),
    },
  },
];

describe('tool-call previews on the message routes', () => {
  let mongoServer;
  let app;
  let conversationId;
  const responseId = 'response-1';

  const assistantContent = () => [
    { type: 'text', text: 'Building now', agentId: 'agent_a' },
    {
      type: 'tool_call',
      agentId: 'agent_a',
      tool_call: {
        id: 'call_bash',
        type: 'tool_call',
        name: 'bash_tool',
        args: fullArgs,
        output: fullOutput,
        progress: 1,
      },
    },
    {
      type: 'tool_call',
      agentId: 'agent_a',
      tool_call: {
        id: 'call_sub',
        type: 'tool_call',
        name: 'subagent',
        args: '{"prompt":"look"}',
        output: 'child summary',
        progress: 1,
        subagent_content: transcript,
      },
    },
  ];

  const storedResponse = async () => {
    const [message] = await mockDb.methods.getMessages({ messageId: responseId, user: OWNER });
    return message;
  };

  const expectStoredContentIntact = async () => {
    const message = await storedResponse();
    expect(message.content[1].tool_call.output).toBe(fullOutput);
    expect(message.content[1].tool_call.args).toBe(fullArgs);
    expect(message.content[1].tool_call).not.toHaveProperty('outputTruncated');
    expect(message.content[2].tool_call.subagent_content).toEqual(transcript);
    expect(message.content[2].tool_call).not.toHaveProperty('subagentContentOmitted');
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const { createModels, createMethods } = jest.requireActual('@librechat/data-schemas');
    createModels(mongoose);
    mockDb.methods = createMethods(mongoose);
    await mongoose.connect(mongoServer.getUri());

    const messagesRouter = require('../messages');
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
      req.user = { id: req.headers['x-user'] ?? OWNER };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.Conversation.deleteMany({});
    conversationId = uuidv4();
    await mockDb.methods.saveConvo(
      { userId: OWNER },
      { conversationId, endpoint: 'agents', title: 'Long chat' },
    );
    await mockDb.methods.saveMessage(
      { userId: OWNER },
      {
        messageId: 'user-1',
        conversationId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
        text: 'build it',
      },
    );
    await mockDb.methods.saveMessage(
      { userId: OWNER },
      {
        messageId: responseId,
        conversationId,
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        endpoint: 'agents',
        text: '',
        content: assistantContent(),
      },
    );
  });

  const loadPreviews = async () => {
    const response = await request(app).get(`/api/messages/${conversationId}?toolPreviews=1`);
    expect(response.status).toBe(200);
    return response.body.find((message) => message.messageId === responseId);
  };

  it('sends previews with markers to a client that asks for them', async () => {
    const message = await loadPreviews();
    const bash = message.content[1].tool_call;
    expect(bash).toMatchObject({
      id: 'call_bash',
      outputTruncated: true,
      outputLength: fullOutput.length,
      argsTruncated: true,
      argsLength: fullArgs.length,
    });
    expect(bash.output.length).toBeLessThanOrEqual(512);
    expect(bash.output.endsWith('[exit code: 0]')).toBe(true);
    expect(JSON.parse(bash.args)).toMatchObject({ command: 'npm run build', intent: 'Build' });
    expect(message.content[2].tool_call).toMatchObject({
      subagentContentOmitted: true,
      subagentContentParts: 2,
      output: 'child summary',
    });
    expect(message.content[2].tool_call).not.toHaveProperty('subagent_content');
    expect(message.content[0]).toEqual({ type: 'text', text: 'Building now', agentId: 'agent_a' });
  });

  it('sends the full payload to an older client that does not ask', async () => {
    const response = await request(app).get(`/api/messages/${conversationId}`);
    const message = response.body.find((entry) => entry.messageId === responseId);
    expect(message.content[1].tool_call.output).toBe(fullOutput);
    expect(message.content[2].tool_call.subagent_content).toEqual(transcript);
    expect(JSON.stringify(response.body)).not.toContain('Truncated');
  });

  it('previews the cursor-paginated conversation read too', async () => {
    const response = await request(app).get(
      `/api/messages?conversationId=${conversationId}&toolPreviews=1&sortBy=createdAt&sortDirection=asc`,
    );
    expect(response.status).toBe(200);
    const message = response.body.messages.find((entry) => entry.messageId === responseId);
    expect(message.content[1].tool_call.outputTruncated).toBe(true);
  });

  it('serves the full part to its owner and nobody else', async () => {
    const url = `/api/messages/${conversationId}/${responseId}/parts/1?toolCallId=call_bash&agentId=agent_a`;
    const owner = await request(app).get(url);
    expect(owner.status).toBe(200);
    expect(owner.body.tool_call.output).toBe(fullOutput);
    expect(owner.body.tool_call.args).toBe(fullArgs);

    const other = await request(app).get(url).set('x-user', OTHER);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain('compiled module');
  });

  describe('a conversation still only live as an active job', () => {
    const { GenerationJobManager } = require('@librechat/api');
    let liveConversationId;

    beforeEach(async () => {
      liveConversationId = uuidv4();
      await mockDb.methods.saveMessage(
        { userId: OWNER },
        {
          messageId: 'live-response',
          conversationId: liveConversationId,
          isCreatedByUser: false,
          content: assistantContent(),
        },
      );
    });

    afterEach(() => {
      GenerationJobManager.getJob.mockResolvedValue(null);
    });

    const partUrl = () =>
      `/api/messages/${liveConversationId}/live-response/parts/1?toolCallId=call_bash&agentId=agent_a`;

    it('serves the part to the job owner, as the conversation read does', async () => {
      GenerationJobManager.getJob.mockResolvedValue({
        status: 'running',
        metadata: { userId: OWNER },
      });
      const list = await request(app).get(`/api/messages/${liveConversationId}?toolPreviews=1`);
      expect(list.status).toBe(200);
      expect(list.body[0].content[1].tool_call.outputTruncated).toBe(true);

      const part = await request(app).get(partUrl());
      expect(part.status).toBe(200);
      expect(part.body.tool_call.output).toBe(fullOutput);
    });

    it("refuses another user's job and a job from another tenant", async () => {
      GenerationJobManager.getJob.mockResolvedValue({
        status: 'running',
        metadata: { userId: OTHER },
      });
      expect((await request(app).get(partUrl())).status).toBe(404);

      GenerationJobManager.getJob.mockResolvedValue({
        status: 'running',
        metadata: { userId: OWNER, tenantId: 'tenant-b' },
      });
      expect((await request(app).get(partUrl())).status).toBe(404);
    });

    it('refuses once the job is no longer active', async () => {
      GenerationJobManager.getJob.mockResolvedValue({
        status: 'complete',
        metadata: { userId: OWNER },
      });
      expect((await request(app).get(partUrl())).status).toBe(404);
    });
  });

  it('does not serve parts of a durable child thread', async () => {
    const childId = uuidv4();
    await mongoose.models.Conversation.create({
      conversationId: childId,
      user: OWNER,
      endpoint: 'agents',
      subagentThread: {
        rootConversationId: conversationId,
        parentConversationId: conversationId,
        parentMessageId: responseId,
        parentToolCallId: 'call_sub',
        subagentType: 'self',
        subagentKind: 'agent',
        depth: 1,
      },
    });
    await mockDb.methods.saveMessage(
      { userId: OWNER },
      { messageId: 'child-msg', conversationId: childId, content: assistantContent() },
    );
    const response = await request(app).get(
      `/api/messages/${childId}/child-msg/parts/1?toolCallId=call_bash&agentId=agent_a`,
    );
    expect(response.status).toBe(404);
  });

  describe('a client holding previews never overwrites stored content', () => {
    it('editing a text part of the previewed message keeps every tool call intact', async () => {
      const preview = await loadPreviews();
      expect(preview.content[1].tool_call.outputTruncated).toBe(true);

      const response = await request(app)
        .put(`/api/messages/${conversationId}/${responseId}`)
        .send({ text: 'Building now, edited', index: 0, model: 'gpt' });
      expect(response.status).toBe(200);

      const stored = await storedResponse();
      expect(stored.content[0].text).toBe('Building now, edited');
      await expectStoredContentIntact();
    });

    it('editing the message text keeps every tool call intact', async () => {
      await loadPreviews();
      const response = await request(app)
        .put(`/api/messages/${conversationId}/${responseId}`)
        .send({ text: 'new text', model: 'gpt' });
      expect(response.status).toBe(200);
      await expectStoredContentIntact();
    });

    it('refuses to save a message body that carries previews', async () => {
      const preview = await loadPreviews();
      const response = await request(app)
        .post(`/api/messages/${conversationId}`)
        .send({ ...preview, conversationId });
      expect(response.status).toBe(400);
      await expectStoredContentIntact();
    });

    it('branching from the previewed message copies the stored content, not the preview', async () => {
      await loadPreviews();
      const response = await request(app)
        .post('/api/messages/branch')
        .send({ messageId: responseId, agentId: 'agent_a' });
      expect(response.status).toBe(201);
      expect(response.body.content[1].tool_call.output).toBe(fullOutput);
      expect(response.body.content[2].tool_call.subagent_content).toEqual(transcript);
      await expectStoredContentIntact();
    });

    it('returns a branched message as a preview to a client that asks, keeping storage full', async () => {
      const response = await request(app)
        .post('/api/messages/branch?toolPreviews=1')
        .send({ messageId: responseId, agentId: 'agent_a' });
      expect(response.status).toBe(201);
      expect(response.body.content[1].tool_call.outputTruncated).toBe(true);
      expect(response.body.content[2].tool_call.subagentContentOmitted).toBe(true);
      const [branched] = await mockDb.methods.getMessages({
        messageId: response.body.messageId,
        user: OWNER,
      });
      expect(branched.content[1].tool_call.output).toBe(fullOutput);
      expect(branched.content[2].tool_call.subagent_content).toEqual(transcript);
    });

    it('forking copies the stored content, not the preview', async () => {
      await loadPreviews();
      const { forkConversation } = require('~/server/utils/import/fork');
      const result = await forkConversation({
        originalConvoId: conversationId,
        targetMessageId: responseId,
        requestUserId: OWNER,
        records: true,
      });
      const forked = result.messages.find((message) => message.isCreatedByUser === false);
      expect(forked.content[1].tool_call.output).toBe(fullOutput);
      expect(forked.content[1].tool_call.args).toBe(fullArgs);
      expect(forked.content[2].tool_call.subagent_content).toEqual(transcript);
      await expectStoredContentIntact();
    });
  });
});
