const mongoose = require('mongoose');
const { v4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  countTokens: jest.fn().mockResolvedValue(1),
}));

jest.mock('~/server/services/Files/process', () => ({ retrieveAndProcessFile: jest.fn() }));

const { Message } = require('~/db/models');
const { saveUserMessage, saveCutOffReply, checkMessageGaps } = require('./manage');

const text = (value) => [{ type: 'text', text: { value, annotations: [] } }];
const messageStep = (id, run_id, message_id) => ({
  id,
  run_id,
  created_at: 2,
  type: 'message_creation',
  step_details: { type: 'message_creation', message_creation: { message_id } },
});

/** A provider thread that answers reads from its own messages and keeps the tags it is sent. */
function createThread() {
  const messages = [];
  const steps = new Map();
  /** What fails: a provider error on the run steps, the network on the messages, or the network
   *  on every call (`offline`), tags included. */
  let failing;
  const openai = {
    beta: {
      threads: {
        messages: {
          list: jest.fn(async () => {
            if (failing === 'messages' || failing === 'offline') {
              throw new Error('Connection error.');
            }
            return { data: messages.map((message) => ({ ...message })) };
          }),
          update: jest.fn(async (id, { metadata }) => {
            if (failing === 'offline') {
              throw new Error('Connection error.');
            }
            const message = messages.find((candidate) => candidate.id === id);
            message.metadata = metadata;
            return message;
          }),
        },
        runs: {
          steps: {
            list: jest.fn(async (run_id) => {
              if (failing === 'steps') {
                throw new Error('400 E2E run steps unavailable');
              }
              return { data: steps.get(run_id) ?? [] };
            }),
          },
        },
      },
    },
  };
  return {
    openai,
    messages,
    steps,
    failReads: (read = 'steps') => (failing = read),
  };
}

describe('Assistants reply of a cancelled run', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  /** One turn: the user message saved, a run cancelled after it streamed two chunks, and the
   *  provider thread holding the three chunks the run wrote before the cancel took effect. */
  async function startTurn({ thread, req, conversationId, parentMessageId, turn }) {
    const user = req.user.id;
    const userMessageId = v4();
    const messageId = v4();
    const run_id = `run_${turn}`;
    await saveUserMessage(req, {
      user,
      conversationId,
      parentMessageId,
      messageId: userMessageId,
      endpoint: 'assistants',
      assistant_id: 'asst_1',
      thread_id: 'thread_1',
      text: `prompt ${turn}`,
    });
    thread.messages.push(
      {
        id: `msg_user_${turn}`,
        role: 'user',
        created_at: turn * 10,
        content: text(`prompt ${turn}`),
        metadata: { messageId: userMessageId },
      },
      {
        id: `msg_reply_${turn}`,
        role: 'assistant',
        run_id,
        assistant_id: 'asst_1',
        created_at: turn * 10 + 1,
        content: text('achunk-001 achunk-002 achunk-003 '),
        metadata: {},
      },
    );
    thread.steps.set(run_id, [messageStep(`step_${turn}`, run_id, `msg_reply_${turn}`)]);
    const cancelled = {
      finalMessage: { content: [] },
      intermediateText: 'achunk-001 achunk-002 ',
      messages: [],
      mappedOrder: new Map([[`msg_reply_${turn}`, 0]]),
      steps: new Map([[`step_${turn}`, messageStep(`step_${turn}`, run_id, `msg_reply_${turn}`)]]),
    };
    const keep = () =>
      saveCutOffReply({
        openai: thread.openai,
        run: cancelled,
        thread_id: 'thread_1',
        conversationId,
        messageId,
        parentMessageId: userMessageId,
        assistant_id: 'asst_1',
        endpoint: 'assistants',
      });
    const readBack = () =>
      checkMessageGaps({
        openai: thread.openai,
        run_id,
        endpoint: 'assistants',
        thread_id: 'thread_1',
        conversationId,
        latestMessageId: messageId,
      });
    return { userMessageId, messageId, keep, readBack };
  }

  function setup(body = {}) {
    const thread = createThread();
    const conversationId = v4();
    const req = { user: { id: new mongoose.Types.ObjectId().toString() }, body, config: {} };
    thread.openai.req = req;
    const replies = () =>
      Message.find({ user: req.user.id, conversationId, isCreatedByUser: false })
        .sort({ createdAt: 1 })
        .lean();
    return { thread, req, conversationId, replies };
  }

  it.each([
    ['steps', '400 E2E run steps unavailable'],
    ['messages', 'Connection error.'],
  ])(
    'keeps what the run streamed when the stop cannot read the run %s back',
    async (read, error) => {
      const { thread, req, conversationId, replies } = setup();
      const turn = await startTurn({ thread, req, conversationId, turn: 1 });

      await turn.keep();
      thread.failReads(read);
      await expect(turn.readBack()).rejects.toThrow(error);

      const [reply, ...others] = await replies();
      expect(others).toHaveLength(0);
      expect(reply).toMatchObject({
        messageId: turn.messageId,
        parentMessageId: turn.userMessageId,
        unfinished: true,
        isUserSubmitted: false,
        content: [{ type: 'text', text: { value: 'achunk-001 achunk-002 ' } }],
      });
      expect(thread.messages[1].metadata).toEqual({ messageId: turn.messageId });
    },
  );

  it('keeps the reply of a temporary chat only as long as the chat', async () => {
    const { thread, req, conversationId, replies } = setup({ isTemporary: true });
    const turn = await startTurn({ thread, req, conversationId, turn: 1 });

    await turn.keep();
    thread.failReads();
    await expect(turn.readBack()).rejects.toThrow();

    const [reply] = await replies();
    const [prompt] = await Message.find({ conversationId, isCreatedByUser: true }).lean();
    expect(reply.isTemporary).toBe(true);
    expect(reply.expiredAt).toBeInstanceOf(Date);
    expect(Math.abs(reply.expiredAt - prompt.expiredAt)).toBeLessThan(60_000);
  });

  it.each([
    ['after the run saved what it streamed', ['keep', 'readBack']],
    ['before the run saved what it streamed', ['readBack', 'keep']],
  ])(
    'saves one reply, the provider copy, when the stop reads the run back %s',
    async (_, order) => {
      const { thread, req, conversationId, replies } = setup();
      const turn = await startTurn({ thread, req, conversationId, turn: 1 });

      for (const step of order) {
        await turn[step]();
      }

      const [reply, ...others] = await replies();
      expect(others).toHaveLength(0);
      expect(reply).toMatchObject({
        messageId: turn.messageId,
        parentMessageId: turn.userMessageId,
        unfinished: false,
        content: text('achunk-001 achunk-002 achunk-003 '),
      });
      expect(thread.messages[1].metadata).toEqual({ messageId: turn.messageId });
    },
  );

  it('keeps a reply in place when its run could not tag it before a later stop', async () => {
    const { thread, req, conversationId, replies } = setup();
    const first = await startTurn({ thread, req, conversationId, turn: 1 });
    thread.failReads('offline');
    await first.keep();
    await expect(first.readBack()).rejects.toThrow('Connection error.');
    expect(thread.messages[1].metadata).toEqual({});

    const ok = createThread();
    ok.messages.push(...thread.messages);
    ok.openai.req = req;
    const second = await startTurn({
      thread: ok,
      req,
      conversationId,
      parentMessageId: first.messageId,
      turn: 2,
    });
    await second.keep();
    await second.readBack();

    const rows = await replies();
    expect(rows.map((row) => [row.messageId, row.parentMessageId, row.unfinished])).toEqual([
      [first.messageId, first.userMessageId, true],
      [second.messageId, second.userMessageId, false],
    ]);
  });

  it('keeps a reply an earlier failed stop saved in place when a later stop reads the thread', async () => {
    const { thread, req, conversationId, replies } = setup();
    const first = await startTurn({ thread, req, conversationId, turn: 1 });
    await first.keep();
    thread.failReads();
    await expect(first.readBack()).rejects.toThrow();

    const ok = createThread();
    ok.messages.push(...thread.messages);
    ok.openai.req = req;
    const second = await startTurn({
      thread: ok,
      req,
      conversationId,
      parentMessageId: first.messageId,
      turn: 2,
    });
    await second.keep();
    await second.readBack();

    const rows = await replies();
    expect(rows.map((row) => [row.messageId, row.parentMessageId, row.unfinished])).toEqual([
      [first.messageId, first.userMessageId, true],
      [second.messageId, second.userMessageId, false],
    ]);
  });
});
