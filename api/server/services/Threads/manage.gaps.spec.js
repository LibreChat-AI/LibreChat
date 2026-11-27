const mongoose = require('mongoose');
const { v4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ContentTypes } = require('librechat-data-provider');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  countTokens: jest.fn().mockResolvedValue(1),
}));

jest.mock('~/server/services/Files/process', () => ({ retrieveAndProcessFile: jest.fn() }));

const { Message } = require('~/db/models');
const { saveUserMessage, checkMessageGaps } = require('./manage');

const text = (value) => ({ type: 'text', text: { value, annotations: [] } });

/**
 * A provider thread: messages and run steps listed newest first, as the API lists them, and
 * message updates (the LibreChat id tags) applied in place.
 */
function createThread(req) {
  const messages = [];
  const steps = new Map();
  let clock = 1000;
  const tick = () => (clock += 1);
  const update = jest.fn(async (id, { metadata }) => {
    const message = messages.find((candidate) => candidate.id === id);
    message.metadata = { ...message.metadata, ...metadata };
    return message;
  });
  const newestFirst = (list) => [...list].sort((a, b) => b.created_at - a.created_at);
  const openai = {
    req,
    beta: {
      threads: {
        messages: {
          update,
          list: jest.fn(async () => ({ data: newestFirst(messages) })),
        },
        runs: {
          steps: { list: jest.fn(async (runId) => ({ data: newestFirst(steps.get(runId)) })) },
        },
      },
    },
  };
  const addMessage = (fields) => {
    const message = { id: `msg_${v4()}`, created_at: tick(), metadata: {}, ...fields };
    messages.push(message);
    return message;
  };
  /** Starts a run that writes each entry in turn: a string is a message, anything else a tool call. */
  const run = (outputs) => {
    const runId = `run_${v4()}`;
    const runSteps = outputs.map((output) => {
      const step = { id: `step_${v4()}`, run_id: runId, assistant_id: 'asst_run' };
      if (typeof output !== 'string') {
        return {
          ...step,
          created_at: tick(),
          step_details: { type: 'tool_calls', tool_calls: [output] },
        };
      }
      const message = addMessage({
        role: 'assistant',
        run_id: runId,
        assistant_id: 'asst_run',
        content: [text(output)],
      });
      return {
        ...step,
        created_at: message.created_at,
        step_details: { type: 'message_creation', message_creation: { message_id: message.id } },
      };
    });
    steps.set(runId, runSteps);
    return runId;
  };
  return { openai, update, messages, addMessage, run };
}

const codeCall = {
  id: 'call_code',
  type: 'code_interpreter',
  code_interpreter: { input: 'print(1)', outputs: [{ type: 'logs', logs: '1' }] },
};

describe('checkMessageGaps', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  /** A conversation whose prompt was saved and posted to the thread, as a send does. */
  async function startTurn(thread, req, params, prompt) {
    const messageId = v4();
    await saveUserMessage(req, {
      ...params,
      messageId,
      text: prompt,
      parentMessageId: params.parentMessageId,
    });
    thread.addMessage({ role: 'user', content: [text(prompt)], metadata: { messageId } });
    return messageId;
  }

  function setup() {
    const user = new mongoose.Types.ObjectId().toString();
    const conversationId = v4();
    const req = {
      user: { id: user },
      body: { conversationId },
      resolvedConversation: null,
      config: {},
    };
    const params = {
      user,
      conversationId,
      endpoint: 'assistants',
      assistant_id: 'asst_test',
      thread_id: 'thread_test',
    };
    return { user, conversationId, req, params, thread: createThread(req) };
  }

  const readBack = ({ thread, conversationId }, run_id, latestMessageId = v4()) =>
    checkMessageGaps({
      openai: thread.openai,
      endpoint: 'assistants',
      thread_id: 'thread_test',
      run_id,
      conversationId,
      latestMessageId,
    });

  const parts = (message) =>
    message.content.map((part) =>
      part.type === ContentTypes.TOOL_CALL ? part.tool_call.id : part.text.value,
    );

  it.each([
    ['a message, a tool call and a message', ['FIRST ', codeCall, 'SECOND']],
    ['two messages', ['FIRST ', 'SECOND']],
  ])('saves each part of a stopped run once, in step order: %s', async (_shape, outputs) => {
    const expected = outputs.map((output) => (typeof output === 'string' ? output : output.id));
    const turn = setup();
    const promptId = await startTurn(turn.thread, turn.req, turn.params, 'go');
    const runId = turn.thread.run(outputs);

    await readBack(turn, runId);

    const rows = await Message.find({ conversationId: turn.conversationId }).lean();
    expect(rows).toHaveLength(2);
    const reply = rows.find((row) => row.isCreatedByUser === false);
    expect(reply.parentMessageId).toBe(promptId);
    expect(parts(reply)).toEqual(expected);
    /* The assistant that ran the reply, not the one that opened the conversation */
    expect(reply.model).toBe('asst_run');
  });

  it('tags every provider message of the run with the saved reply', async () => {
    const turn = setup();
    await startTurn(turn.thread, turn.req, turn.params, 'go');
    const runId = turn.thread.run(['FIRST ', codeCall, 'SECOND']);

    await readBack(turn, runId);

    const reply = await Message.findOne({
      conversationId: turn.conversationId,
      isCreatedByUser: false,
    }).lean();
    const runMessages = turn.thread.messages.filter((message) => message.run_id === runId);
    expect(runMessages).toHaveLength(2);
    for (const message of runMessages) {
      expect(message.metadata.messageId).toBe(reply.messageId);
    }
  });

  it('keeps a stopped run in its saved reply when a later run of the thread is read back', async () => {
    const turn = setup();
    const firstPrompt = await startTurn(turn.thread, turn.req, turn.params, 'go');
    const firstRun = turn.thread.run(['FIRST ', codeCall, 'SECOND']);
    await readBack(turn, firstRun);
    const firstReply = await Message.findOne({
      conversationId: turn.conversationId,
      parentMessageId: firstPrompt,
    }).lean();

    const nextPrompt = await startTurn(
      turn.thread,
      turn.req,
      {
        ...turn.params,
        parentMessageId: firstReply.messageId,
      },
      'again',
    );
    const nextRun = turn.thread.run(['THIRD']);
    await readBack(turn, nextRun);

    const rows = await Message.find({ conversationId: turn.conversationId }).lean();
    expect(rows).toHaveLength(4);
    const replies = rows.filter((row) => row.isCreatedByUser === false);
    expect(replies.map(parts)).toEqual(
      expect.arrayContaining([['FIRST ', 'call_code', 'SECOND'], ['THIRD']]),
    );
    expect(replies.find((row) => parts(row).includes('THIRD')).parentMessageId).toBe(nextPrompt);
  });

  it.each([
    ['one message', ['ONLY']],
    ['a message, a tool call and a message', ['FIRST ', codeCall, 'SECOND']],
  ])('keeps one reply when the same run is read back twice: %s', async (_shape, outputs) => {
    const expected = outputs.map((output) => (typeof output === 'string' ? output : output.id));
    const turn = setup();
    await startTurn(turn.thread, turn.req, turn.params, 'go');
    const runId = turn.thread.run(outputs);
    const responseId = v4();

    /* A failed run is read back by its error and again when its response closes */
    await readBack(turn, runId, responseId);
    await readBack(turn, runId, responseId);

    const replies = await Message.find({
      conversationId: turn.conversationId,
      isCreatedByUser: false,
    }).lean();
    expect(replies.map(parts)).toEqual([expected]);
  });

  it('saves a run that only called tools as one reply', async () => {
    const turn = setup();
    const promptId = await startTurn(turn.thread, turn.req, turn.params, 'go');
    const runId = turn.thread.run([codeCall]);

    await readBack(turn, runId);

    const reply = await Message.findOne({
      conversationId: turn.conversationId,
      isCreatedByUser: false,
    }).lean();
    expect(reply.parentMessageId).toBe(promptId);
    expect(parts(reply)).toEqual(['call_code']);
    expect(turn.thread.update).not.toHaveBeenCalled();
  });
});
