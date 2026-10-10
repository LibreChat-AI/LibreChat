import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { ContentTypes } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  logger,
  createMethods,
  createModels,
  tenantStorage,
  CLIENT_MESSAGE_SELECT,
} from '@librechat/data-schemas';
import type { AllMethods, IMessage } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { MessageValidationResult } from '~/middleware/messageValidation';
import type { ToolCallPartDeps, ToolCallPartHandlerDeps } from './parts';
import { previewMessagesToolCalls } from './previews';
import { createToolCallPartHandler } from './parts';

let mongod: MongoMemoryServer;
let methods: AllMethods;
let app: express.Express;

const OWNER = 'owner-user';
const conversationId = '7f9c2b1e-4a5d-4c3b-9e8f-1a2b3c4d5e6f';
const otherConversationId = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const messageId = 'msg-parts';

const longOutput = `stdout:\n${'line of build output\n'.repeat(2_000)}[exit code: 0]`;
const longArgs = JSON.stringify({
  command: 'npm run build',
  intent: 'Build',
  pad: 'p'.repeat(5_000),
});
const transcript = [
  { type: ContentTypes.TEXT, text: 'child text' },
  {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id: 'child_1',
      name: 'read_file',
      args: '{"path":"a"}',
      output: 'x'.repeat(3_000),
    },
  },
];

function content() {
  return [
    { type: ContentTypes.TEXT, text: 'Working on it' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call_bash',
        type: 'tool_call',
        name: 'bash_tool',
        args: longArgs,
        output: longOutput,
        progress: 1,
        backgroundTask: {
          version: 1,
          taskId: 'task-1',
          toolName: 'bash_tool',
          status: 'completed',
          settledAt: new Date('2026-10-01T00:00:00Z'),
          resultClaim: { kind: 'manual', claimId: 'secret-claim', claimedAt: new Date() },
        },
      },
    },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call_sub',
        type: 'tool_call',
        name: 'subagent',
        args: '{"prompt":"look around"}',
        output: 'child summary',
        progress: 1,
        subagent_content: transcript,
      },
    },
  ];
}

async function seed(user = OWNER, overrides: Partial<IMessage> = {}) {
  await methods.saveMessage(
    { userId: user },
    {
      messageId,
      conversationId,
      parentMessageId: 'parent',
      isCreatedByUser: false,
      text: '',
      content: content(),
      ...overrides,
    },
  );
}

function withUser(req: Request, _res: Response, next: NextFunction) {
  (req as Request & { user: { id: string } }).user = {
    id: (req.headers['x-user'] as string | undefined) ?? OWNER,
  };
  const tenantId = req.headers['x-tenant'] as string | undefined;
  if (tenantId == null) {
    next();
    return;
  }
  tenantStorage.run({ tenantId }, () => next());
}

const allow = (): Pick<ToolCallPartHandlerDeps, 'validate' | 'sendValidationResponse'> => ({
  validate: () => ({
    conversationId,
    shouldFetchMessages: true,
    promise: Promise.resolve<MessageValidationResult>({ ok: true }),
  }),
  sendValidationResponse: (res, result) => res.status(result.status).json(result.body),
});

const handler = (
  getMessages: ToolCallPartDeps['getMessages'],
  validation: Partial<ToolCallPartHandlerDeps> = {},
) => createToolCallPartHandler({ getMessages, ...allow(), ...validation });

const mount = (route: ReturnType<typeof handler>) => {
  const server = express();
  server.use(withUser);
  server.get('/api/messages/:conversationId/:messageId/parts/:partIndex', route);
  return server;
};

/** `toolCallId` defaults to the seeded bash call; `null` leaves the parameter out. */
const partUrl = (
  index: number | string,
  toolCallId: string | null = 'call_bash',
  convo = conversationId,
) =>
  `/api/messages/${convo}/${messageId}/parts/${index}${
    toolCallId == null ? '' : `?toolCallId=${encodeURIComponent(toolCallId)}`
  }`;

beforeAll(async () => {
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
  mongod = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(withUser);
  app.get(
    '/api/messages/:conversationId/:messageId/parts/:partIndex',
    handler((filter, select) => methods.getMessages(filter, select)),
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await (mongoose.models.Message as mongoose.Model<IMessage>).deleteMany({});
});

describe('GET /api/messages/:conversationId/:messageId/parts/:partIndex', () => {
  it('returns the stored tool call in full, exactly as a full conversation load sends it', async () => {
    await seed();
    const response = await request(app).get(partUrl(1, 'call_bash'));
    expect(response.status).toBe(200);

    const [stored] = await methods.getMessages(
      { conversationId, messageId, user: OWNER },
      CLIENT_MESSAGE_SELECT,
    );
    const fullLoadPart = JSON.parse(JSON.stringify((stored.content as unknown[])[1]));
    expect(response.body).toEqual({
      conversationId,
      messageId,
      partIndex: 1,
      tool_call: fullLoadPart.tool_call,
    });
    expect(response.body.tool_call.output).toBe(longOutput);
    expect(response.body.tool_call.args).toBe(longArgs);
    expect(response.body.tool_call.backgroundTask).toMatchObject({ taskId: 'task-1' });
    expect(response.body.tool_call.backgroundTask).not.toHaveProperty('resultClaim');
  });

  it('restores everything a preview left out, subagent transcript included', async () => {
    await seed();
    const [stored] = await methods.getMessages(
      { conversationId, messageId, user: OWNER },
      CLIENT_MESSAGE_SELECT,
    );
    const [previewed] = previewMessagesToolCalls([stored], { outputChars: 512, argsChars: 512 });
    const previewParts = previewed.content as Array<{ tool_call?: Record<string, unknown> }>;
    expect(previewParts[1].tool_call).toMatchObject({ outputTruncated: true, argsTruncated: true });
    expect(previewParts[2].tool_call).toMatchObject({
      subagentContentOmitted: true,
      subagentContentParts: 2,
    });

    const sub = await request(app).get(partUrl(2, 'call_sub'));
    expect(sub.status).toBe(200);
    expect(sub.body.tool_call.subagent_content).toEqual(transcript);
    expect(sub.body.tool_call).not.toHaveProperty('subagentContentOmitted');
  });

  it('finds the part by tool-call id when the client copy is out of position', async () => {
    await seed();
    const response = await request(app).get(partUrl(0, 'call_sub'));
    expect(response.status).toBe(200);
    expect(response.body.partIndex).toBe(2);
    expect(response.body.tool_call.id).toBe('call_sub');
  });

  it('tells repeated provider ids apart by step and agent, refusing an ambiguous match', async () => {
    const repeated = (agentId: string, stepId: string, output: string) => ({
      type: ContentTypes.TOOL_CALL,
      agentId,
      tool_call: {
        id: 'call_dup',
        type: 'tool_call',
        name: 'read_file',
        stepId,
        output,
        args: '{}',
      },
    });
    await seed(OWNER, {
      content: [
        { type: ContentTypes.TEXT, text: 'two agents' },
        repeated('agent_a', 'step_a', 'from agent a'),
        repeated('agent_b', 'step_b', 'from agent b'),
      ],
    });
    const identity = (agentId: string, stepId: string) =>
      `${partUrl(0, 'call_dup')}&stepId=${stepId}&agentId=${agentId}`;
    const agentB = await request(app).get(identity('agent_b', 'step_b'));
    expect(agentB.status).toBe(200);
    expect(agentB.body).toMatchObject({ partIndex: 2, tool_call: { output: 'from agent b' } });

    const agentA = await request(app).get(identity('agent_a', 'step_a'));
    expect(agentA.body).toMatchObject({ partIndex: 1, tool_call: { output: 'from agent a' } });

    /** An index pointing at the other agent's call does not win over the identity. */
    const shifted = await request(app).get(
      `${partUrl(1, 'call_dup')}&stepId=step_b&agentId=agent_b`,
    );
    expect(shifted.body).toMatchObject({ partIndex: 2 });

    /** Without the step and agent, both calls carry the requested identity loosely; neither does
     *  exactly, so nothing is returned. */
    expect((await request(app).get(partUrl(1, 'call_dup'))).status).toBe(404);
  });

  it('refuses an identity that repeats exactly, even when the index points at one occurrence', async () => {
    const twin = (output: string) => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call_twin', type: 'tool_call', name: 'read_file', output, args: '{}' },
    });
    await seed(OWNER, { content: [twin('first'), twin('second')] });
    expect((await request(app).get(partUrl(0, 'call_twin'))).status).toBe(404);
    expect((await request(app).get(partUrl(1, 'call_twin'))).status).toBe(404);
  });

  it('treats an empty step or agent as absent, so such a preview stays fetchable', async () => {
    await seed(OWNER, {
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          agentId: '',
          tool_call: {
            id: 'call_empty',
            stepId: '',
            type: 'tool_call',
            name: 'bash_tool',
            output: 'done',
            args: '{}',
          },
        },
      ],
    });
    const response = await request(app).get(partUrl(0, 'call_empty'));
    expect(response.status).toBe(200);
    expect(response.body.tool_call.id).toBe('call_empty');
  });

  it('serves a call whose provider id is unusually long', async () => {
    const longId = `call_${'x'.repeat(2_000)}`;
    await seed(OWNER, {
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: longId,
            type: 'tool_call',
            name: 'bash_tool',
            output: 'done',
            args: '{}',
          },
        },
      ],
    });
    const response = await request(app).get(partUrl(0, longId));
    expect(response.status).toBe(200);
    expect(response.body.tool_call.id).toBe(longId);
  });

  it('answers not found for a missing part, a non-tool part, or an unknown id', async () => {
    await seed();
    expect((await request(app).get(partUrl(9, 'call_missing'))).status).toBe(404);
    expect((await request(app).get(partUrl(250_000, 'call_missing'))).status).toBe(404);
    expect((await request(app).get(partUrl(0, 'call_missing'))).status).toBe(404);
    expect((await request(app).get(partUrl(1, 'call_missing'))).status).toBe(404);
  });

  it("never returns another user's message", async () => {
    await seed();
    const response = await request(app).get(partUrl(1)).set('x-user', 'intruder');
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('line of build output');
  });

  it('never returns a message through a different conversation id', async () => {
    await seed();
    const response = await request(app).get(partUrl(1, 'call_bash', otherConversationId));
    expect(response.status).toBe(404);
  });

  it('never crosses tenants, even for the same user id', async () => {
    await tenantStorage.run({ tenantId: 'tenant-a' }, () => seed());
    const sameTenant = await request(app).get(partUrl(1)).set('x-tenant', 'tenant-a');
    expect(sameTenant.status).toBe(200);
    const otherTenant = await request(app).get(partUrl(1)).set('x-tenant', 'tenant-b');
    expect(otherTenant.status).toBe(404);
  });

  it('rejects malformed coordinates before reading', async () => {
    const getMessages = jest.fn();
    const strict = mount(handler(getMessages));
    expect((await request(strict).get(partUrl(1, null))).status).toBe(400);
    expect((await request(strict).get(partUrl('-1'))).status).toBe(400);
    expect((await request(strict).get(partUrl('1.5'))).status).toBe(400);
    expect((await request(strict).get(partUrl('99999999999999999999'))).status).toBe(400);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('starts the part read beside access validation and answers only once it passes', async () => {
    await seed();
    const events: string[] = [];
    let release: (result: MessageValidationResult) => void = () => undefined;
    const pending = new Promise<MessageValidationResult>((resolve) => (release = resolve));
    const server = mount(
      handler(
        (filter, select) => {
          events.push('read');
          return methods.getMessages(filter, select);
        },
        { validate: () => ({ conversationId, shouldFetchMessages: true, promise: pending }) },
      ),
    );
    const response = request(server)
      .get(partUrl(1))
      .then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.push('validated');
    release({ ok: true });
    expect((await response).status).toBe(200);
    expect(events).toEqual(['read', 'validated']);
  });

  it('sends the validation verdict, never the part, when access is refused', async () => {
    await seed();
    const server = mount(
      handler((filter, select) => methods.getMessages(filter, select), {
        validate: () => ({
          conversationId,
          shouldFetchMessages: true,
          promise: Promise.resolve<MessageValidationResult>({
            ok: false,
            status: 403,
            body: { error: 'User not authorized for this conversation' },
          }),
        }),
      }),
    );
    const response = await request(server).get(partUrl(1));
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('line of build output');
  });

  it('answers not found for the placeholder conversation without reading', async () => {
    const getMessages = jest.fn();
    const server = mount(
      handler(getMessages, {
        validate: () => ({
          conversationId: 'new',
          shouldFetchMessages: false,
          promise: Promise.resolve<MessageValidationResult>({
            ok: false,
            status: 200,
            body: [],
            send: true,
          }),
        }),
      }),
    );
    expect((await request(server).get(partUrl(1))).status).toBe(404);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('reports a read failure as a server error without leaking it', async () => {
    const failing = mount(handler(jest.fn().mockRejectedValue(new Error('db down'))));
    const response = await request(failing).get(partUrl(1));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});
