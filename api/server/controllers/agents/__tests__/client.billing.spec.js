const { tool } = require('@librechat/agents/langchain/tools');
const { z } = require('zod');
const { GraphEvents } = require('@librechat/agents');
const { Constants, ContentTypes, EModelEndpoint } = require('librechat-data-provider');
const { GenerationJobManager } = require('@librechat/api');
const AgentClient = require('../client');
const { ModelEndHandler } = require('../callbacks');
const db = require('~/models');

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
  getMessages: jest.fn().mockResolvedValue([]),
  getConvo: jest.fn().mockResolvedValue(null),
  updateMessage: jest.fn().mockResolvedValue(undefined),
  saveMessage: jest.fn(async (_ctx, message) => message),
  saveConvo: jest.fn().mockResolvedValue({}),
  stampConvoLastResponse: jest.fn().mockResolvedValue({}),
  getMultiplier: jest.fn(() => 1),
  getCacheMultiplier: jest.fn(() => null),
  reserveBalance: jest.fn().mockResolvedValue({ reserved: true, balance: 1000000 }),
  renewBalanceReservation: jest.fn().mockResolvedValue({ renewed: true }),
  releaseBalanceReservation: jest.fn().mockResolvedValue(undefined),
  spendTokens: jest.fn().mockResolvedValue(undefined),
  spendStructuredTokens: jest.fn().mockResolvedValue(undefined),
  bulkInsertTransactions: jest.fn().mockResolvedValue(undefined),
  updateBalance: jest.fn().mockResolvedValue({}),
  isAgentTriggerPrincipalActive: jest.fn().mockResolvedValue(true),
}));
jest.mock('~/server/services/Config', () => ({ getMCPServerTools: jest.fn() }));
jest.mock('~/config', () => ({
  getMCPManager: () => ({ formatInstructionsForContext: async () => '' }),
}));

function fixture({
  fail = false,
  stop = false,
  reported = false,
  multiCall = false,
  stopAfterTool = false,
} = {}) {
  const abortController = new AbortController();
  const collectedUsage = [];
  const requests = [];
  const fetch = jest.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (stop) {
      abortController.abort();
      throw new DOMException('Stopped', 'AbortError');
    }
    if (fail || (multiCall && requests.length > 1)) {
      return Response.json(
        { error: { message: 'Unavailable', type: 'server_error' } },
        { status: 503 },
      );
    }
    const delta = multiCall
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'next_step', arguments: '{}' },
            },
          ],
        }
      : { content: 'Answer' };
    const usage = reported
      ? { prompt_tokens: 300000, completion_tokens: 5, total_tokens: 300005 }
      : undefined;
    const chunk = {
      id: 'completion-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', ...delta },
          finish_reason: multiCall ? 'tool_calls' : 'stop',
        },
      ],
      usage,
    };
    if (request.stream) {
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({
      ...chunk,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', ...delta },
          finish_reason: multiCall ? 'tool_calls' : 'stop',
        },
      ],
    });
  });
  const client = new AgentClient({
    req: {
      user: { id: 'user-billing' },
      body: { endpoint: EModelEndpoint.agents },
      config: {
        balance: { enabled: true },
        memory: { disabled: true },
        endpoints: {
          agents: { askUserQuestion: { enabled: false }, toolApproval: { enabled: false } },
        },
      },
    },
    res: {},
    endpoint: EModelEndpoint.agents,
    maxContextTokens: 512,
    agent: {
      id: 'agent-billing',
      endpoint: EModelEndpoint.openAI,
      provider: EModelEndpoint.openAI,
      maxContextTokens: 512,
      model_parameters: {
        model: 'gpt-4o-mini',
        apiKey: 'fixture',
        maxRetries: 0,
        configuration: { baseURL: 'https://billing.invalid/v1', fetch },
      },
      tools: multiCall
        ? [
            tool(
              async () => {
                if (stopAfterTool) {
                  abortController.abort();
                }
                return 'Continue';
              },
              {
                name: 'next_step',
                description: 'Continue',
                schema: z.object({}),
              },
            ),
          ]
        : [],
      summarization: { enabled: false },
    },
    contentParts: [],
    collectedUsage,
    artifactPromises: [],
    eventHandlers: { [GraphEvents.CHAT_MODEL_END]: new ModelEndHandler(collectedUsage) },
  });
  client.model = 'gpt-4o-mini';
  const send = (text = 'Continue', options = {}) =>
    client.sendMessage(text, {
      user: 'user-billing',
      conversationId: 'conversation-billing',
      abortController,
      ...options,
    });
  return { client, send, requests, fetch, abortController };
}

describe('AgentClient billing through BaseClient and the real runtime', () => {
  afterAll(async () => {
    await GenerationJobManager.destroy();
  });

  it('does not bill when real pruning rejects every message before model invocation', async () => {
    const { send, requests, client } = fixture();

    const response = await send('too large '.repeat(3000));

    expect(requests).toHaveLength(0);
    expect(client.contentParts).toEqual([expect.objectContaining({ type: ContentTypes.ERROR })]);
    expect(client.contentParts[0].error).toContain('empty_messages');
    expect(db.spendTokens).not.toHaveBeenCalled();
    expect(response.promptTokens).toBe(512);
    expect(db.bulkInsertTransactions).not.toHaveBeenCalled();
    expect(db.releaseBalanceReservation).toHaveBeenCalledTimes(1);
  });

  it('does not bill a provider failure before usage', async () => {
    const { send, requests, client } = fixture({ fail: true });

    await send();

    expect(requests).toHaveLength(1);
    expect(client.contentParts).toEqual([expect.objectContaining({ type: ContentTypes.ERROR })]);
    expect(db.spendTokens).not.toHaveBeenCalled();
    expect(db.bulkInsertTransactions).not.toHaveBeenCalled();
  });

  it('preserves real usage from a completed tool call before a terminal provider failure', async () => {
    const { send, requests, client } = fixture({ multiCall: true, reported: true });

    await send();

    expect(requests).toHaveLength(2);
    expect(client.contentParts).toContainEqual(
      expect.objectContaining({ type: ContentTypes.ERROR }),
    );
    expect(db.bulkInsertTransactions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ tokenType: 'prompt', rawAmount: -300000 }),
        expect.objectContaining({ tokenType: 'completion', rawAmount: -5 }),
      ]),
    );
    expect(db.spendTokens).not.toHaveBeenCalled();
  });

  it('bills reported usage once under abort when Stop follows a completed model call', async () => {
    const { send, requests } = fixture({ multiCall: true, reported: true, stopAfterTool: true });

    await send();

    expect(requests).toHaveLength(1);
    expect(db.bulkInsertTransactions).toHaveBeenCalledTimes(1);
    expect(db.bulkInsertTransactions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ context: 'abort', tokenType: 'prompt', rawAmount: -300000 }),
        expect.objectContaining({ context: 'abort', tokenType: 'completion', rawAmount: -5 }),
      ]),
    );
    expect(db.spendTokens).not.toHaveBeenCalled();
  });

  it('does not estimate a cancelled provider call rendered as terminal error', async () => {
    const { send, requests, client } = fixture({ stop: true });

    await send();

    expect(requests).toHaveLength(1);
    expect(client.contentParts).toEqual([expect.objectContaining({ type: ContentTypes.ERROR })]);
    expect(db.spendTokens).not.toHaveBeenCalled();
  });

  it('admits prunable long history and bounds successful unreported-usage fallback', async () => {
    db.getMessages.mockResolvedValueOnce([
      {
        messageId: 'old-user',
        parentMessageId: Constants.NO_PARENT,
        text: 'Old prompt',
        tokenCount: 1000000,
        isCreatedByUser: true,
      },
      {
        messageId: 'old-answer',
        parentMessageId: 'old-user',
        text: 'Old answer',
        tokenCount: 1277600,
        isCreatedByUser: false,
      },
    ]);
    db.reserveBalance.mockImplementationOnce(async ({ amount }) => ({
      reserved: amount <= 512,
      balance: 512,
    }));
    const { send, requests } = fixture();

    const response = await send('Continue', { parentMessageId: 'old-answer' });

    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Continue' }] }),
    ]);
    expect(response.promptTokens).toBe(512);
    expect(db.reserveBalance).toHaveBeenCalledWith(expect.objectContaining({ amount: 512 }));
    expect(db.spendTokens).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'message' }),
      expect.objectContaining({ promptTokens: 512 }),
    );
  });

  it('still refuses an exhausted balance before any provider request', async () => {
    db.reserveBalance.mockResolvedValueOnce({ reserved: false, balance: 0 });
    const { send, requests } = fixture();

    await expect(send()).rejects.toThrow('token_balance');

    expect(requests).toHaveLength(0);
    expect(db.spendTokens).not.toHaveBeenCalled();
  });
});
