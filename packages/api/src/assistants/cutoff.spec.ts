import { logger } from '@librechat/data-schemas';
import type { CutOffParams, CutOffRun } from './cutoff';
import type { AssistantRunHandle } from './run';
import { saveCutOffReply, cutOffContent } from './cutoff';

const toolCall = { type: 'tool_call', tool_call: { id: 'call_1', type: 'code_interpreter' } };
const text = (value: string) => ({ type: 'text', text: { value } });
const messageStep = (message_id: string) => ({
  step_details: { type: 'message_creation', message_creation: { message_id } },
});

/** A streamed run that finished `msg_1`, called a tool, and was cut while streaming `msg_2`. */
const cutRun = (): CutOffRun => ({
  finalMessage: { content: [text('Done.'), toolCall] },
  intermediateText: 'Done.achunk-001 achunk-002 ',
  messages: [{ content: [{ type: 'text', text: { value: 'Done.', annotations: [] } }] }],
  mappedOrder: new Map([
    ['msg_1', 0],
    ['step_tool_call_0_code_interpreter', 1],
    ['msg_2', 2],
  ]),
  steps: new Map([
    ['step_1', messageStep('msg_1')],
    ['step_2', messageStep('msg_2')],
  ]),
});

describe('cutOffContent', () => {
  it('keeps each finished part and adds the text of the message the stream cut', () => {
    expect(cutOffContent(cutRun())).toEqual([
      text('Done.'),
      toolCall,
      text('achunk-001 achunk-002 '),
    ]);
  });

  it('adds nothing when the run was cut after its last message finished', () => {
    const run = { ...cutRun(), intermediateText: 'Done.' };

    expect(cutOffContent(run)).toEqual([text('Done.'), toolCall]);
  });

  it('keeps the parts a polled run showed, which streams no text', () => {
    const polled = [toolCall, undefined, text('polled')];

    expect(cutOffContent({ finalMessage: { content: polled } })).toEqual([
      toolCall,
      text('polled'),
    ]);
  });
});

describe('saveCutOffReply', () => {
  function setup({
    stored,
    stopped = false,
  }: {
    stored?: (message: Record<string, unknown>) => Record<string, unknown>;
    stopped?: boolean;
  } = {}) {
    const saveMessage = jest.fn(async (_ctx: unknown, message: Record<string, unknown>) =>
      stored ? stored(message) : message,
    );
    const addThreadMetadata = jest.fn().mockResolvedValue(undefined);
    const params: CutOffParams = {
      openai: {
        req: {
          user: { id: 'user-123' },
          body: { isTemporary: false },
          assistantRun: { stopped } as AssistantRunHandle,
        },
        beta: { threads: { messages: { update: jest.fn() } } },
      },
      run: {
        finalMessage: { content: [] },
        intermediateText: 'achunk-001 ',
        mappedOrder: new Map([['msg_1', 0]]),
        steps: new Map([['step_1', messageStep('msg_1')]]),
      },
      thread_id: 'thread_1',
      conversationId: 'convo-123',
      messageId: 'reply-1',
      parentMessageId: 'user-1',
      assistant_id: 'asst_1',
      endpoint: 'assistants',
      iconURL: 'https://example.com/icon.png',
    };
    return { deps: { saveMessage, addThreadMetadata }, saveMessage, addThreadMetadata, params };
  }

  it('saves what streamed as an unfinished reply and tags its provider message', async () => {
    const { deps, saveMessage, addThreadMetadata, params } = setup();

    await saveCutOffReply(deps, params);

    expect(saveMessage).toHaveBeenCalledTimes(1);
    const [ctx, message, options] = saveMessage.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      unknown,
    ];
    expect(ctx).toEqual(expect.objectContaining({ userId: 'user-123', isTemporary: false }));
    expect(message).toEqual({
      user: 'user-123',
      messageId: 'reply-1',
      conversationId: 'convo-123',
      parentMessageId: 'user-1',
      thread_id: 'thread_1',
      endpoint: 'assistants',
      model: 'asst_1',
      sender: 'Assistant',
      isCreatedByUser: false,
      isUserSubmitted: false,
      content: [text('achunk-001 ')],
      unfinished: true,
      iconURL: 'https://example.com/icon.png',
    });
    expect(options).toEqual(expect.objectContaining({ insertOnly: true }));
    expect(addThreadMetadata).toHaveBeenCalledWith({
      openai: params.openai,
      thread_id: 'thread_1',
      messageId: 'reply-1',
      messages: [{ id: 'msg_1' }],
    });
  });

  it('saves the reply only once the prompt it answers is saved', async () => {
    const { deps, saveMessage, params } = setup();
    let savePrompt!: () => void;
    const userMessage = new Promise<void>((resolve) => (savePrompt = resolve));

    const saving = saveCutOffReply(deps, { ...params, userMessage });
    await new Promise((resolve) => setImmediate(resolve));
    expect(saveMessage).not.toHaveBeenCalled();

    savePrompt();
    await saving;
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the reply the read-back saved first alone', async () => {
    const { deps, addThreadMetadata, params } = setup({
      stored: (message) => ({ ...message, unfinished: false }),
    });

    await saveCutOffReply(deps, params);

    expect(addThreadMetadata).not.toHaveBeenCalled();
  });

  it('writes nothing for a run stopped for account deletion', async () => {
    const { deps, saveMessage, addThreadMetadata, params } = setup({ stopped: true });

    await saveCutOffReply(deps, params);

    expect(saveMessage).not.toHaveBeenCalled();
    expect(addThreadMetadata).not.toHaveBeenCalled();
  });

  it('writes nothing for a run cancelled before it streamed anything', async () => {
    const { deps, saveMessage, params } = setup();

    await saveCutOffReply(deps, { ...params, run: { ...params.run, intermediateText: '' } });

    expect(saveMessage).not.toHaveBeenCalled();
  });

  it('keeps the saved reply when its provider message cannot be tagged', async () => {
    const { deps, saveMessage, addThreadMetadata, params } = setup();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    addThreadMetadata.mockRejectedValueOnce(new Error('connect ECONNRESET'));
    try {
      await expect(saveCutOffReply(deps, params)).resolves.toBeUndefined();
      expect(saveMessage).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[saveCutOffReply] Could not tag the cut-off reply on its thread',
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
