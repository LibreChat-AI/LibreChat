import { Constants, StepTypes, StepEvents, ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  ChatEvent,
  ChatStreamRequest,
  ChatTransportOptions,
  ChatTransport as WireTransport,
} from 'librechat-data-provider';
import type { ChatEventContext, ChatState } from '../chat';
import type { ChatStatus } from '../types';
import { createGenerationTransport } from '../transport';
import { createEventApplier } from '../apply';
import { Chat } from '../chat';

const user: TMessage = {
  messageId: 'user-1',
  conversationId: 'thread-1',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
  text: 'Go',
  sender: 'User',
};

const createList = (initial: TMessage[] = []) => {
  let messages = initial;
  const writes: TMessage[][] = [];
  const context: ChatEventContext = {
    get messages() {
      return messages;
    },
    write(next) {
      messages = next;
      writes.push(next);
    },
  };
  return { context, writes, read: () => messages };
};

const runStep = (id: string, index: number): Agents.RunStep => ({
  id,
  runId: 'resp-1',
  index,
  type: StepTypes.MESSAGE_CREATION,
  stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: id } },
  usage: null,
});

const opened = (id: string, index: number): ChatEvent =>
  ({
    type: 'step',
    data: { event: StepEvents.ON_RUN_STEP, data: runStep(id, index) },
  }) as ChatEvent;

const delta = (id: string, text: string) => ({
  event: StepEvents.ON_MESSAGE_DELTA,
  data: { id, delta: { content: [{ type: ContentTypes.TEXT, text }] } },
});

const token = (id: string, text: string): ChatEvent =>
  ({ type: 'step', data: delta(id, text) }) as ChatEvent;

const created: ChatEvent = { type: 'created', data: { created: true, message: user } };

/** What the server sends a chat that attaches after `text` was already streamed. */
const snapshot = (text: string, extra: Partial<Agents.ResumeState> = {}): ChatEvent =>
  ({
    type: 'sync',
    data: {
      sync: true,
      resumeState: {
        conversationId: 'thread-1',
        responseMessageId: 'resp-1',
        sender: 'Researcher',
        userMessage: {
          messageId: 'user-1',
          parentMessageId: Constants.NO_PARENT,
          conversationId: 'thread-1',
          text: 'Go',
        },
        runSteps: [runStep('s0', 0)],
        aggregatedContent: text === '' ? [] : [{ type: ContentTypes.TEXT, text }],
        ...extra,
      },
    },
  }) as ChatEvent;

const final = (text: string): ChatEvent =>
  ({
    type: 'final',
    data: {
      final: true,
      conversation: { conversationId: 'thread-1' },
      requestMessage: user,
      responseMessage: {
        messageId: 'resp-1',
        conversationId: 'thread-1',
        parentMessageId: 'user-1',
        isCreatedByUser: false,
        text: '',
        content: [{ type: ContentTypes.TEXT, text }],
      },
    },
  }) as ChatEvent;

const response = (messages: TMessage[]) =>
  messages.find((message) => message.messageId === 'resp-1');

const textOf = (messages: TMessage[]) =>
  (response(messages)?.content ?? []).map((part) => (part as { text?: string } | undefined)?.text);

const shape = (messages: TMessage[]) =>
  messages.map(({ messageId, parentMessageId, isCreatedByUser, content }) => ({
    messageId,
    parentMessageId,
    isCreatedByUser,
    content,
  }));

describe('createEventApplier', () => {
  it('rebuilds the turn from a snapshot when the list holds none of it', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();

    applyEvent(snapshot('Hel'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(read()[0]).toMatchObject({ isCreatedByUser: true, text: 'Go' });
    expect(response(read())).toMatchObject({
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      sender: 'Researcher',
    });
    expect(textOf(read())).toEqual(['Hel']);
  });

  it('continues the snapshot with the tokens that follow it', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();

    applyEvent(snapshot('Hel'), context);
    applyEvent(token('s0', 'lo'), context);
    applyEvent(opened('s1', 1), context);
    applyEvent(token('s1', ' there'), context);

    expect(textOf(read())).toEqual(['Hello', ' there']);
  });

  it('leaves a chat that joined late holding what one that watched from the start holds', () => {
    const watcher = createList([user]);
    const joiner = createList([user]);
    const watching = createEventApplier();
    const joining = createEventApplier();

    for (const event of [created, opened('s0', 0), token('s0', 'Hel'), token('s0', 'lo')]) {
      watching.applyEvent(event, watcher.context);
    }
    joining.applyEvent(snapshot('Hel'), joiner.context);
    joining.applyEvent(token('s0', 'lo'), joiner.context);

    expect(textOf(joiner.read())).toEqual(['Hello']);
    expect(shape(joiner.read())).toEqual(shape(watcher.read()));

    watching.applyEvent(final('Hello'), watcher.context);
    joining.applyEvent(final('Hello'), joiner.context);
    expect(shape(joiner.read())).toEqual(shape(watcher.read()));
  });

  it('takes the snapshot over a stale copy of the same response', () => {
    const stale: TMessage = {
      messageId: 'resp-1',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.TEXT, text: 'H' }],
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, stale]);

    applyEvent(snapshot('Hello'), context);

    expect(read()).toHaveLength(2);
    expect(textOf(read())).toEqual(['Hello']);
  });

  it('keeps loaded content when the snapshot carries none', () => {
    const loaded: TMessage = {
      messageId: 'resp-1',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.TEXT, text: 'Loaded' }],
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, loaded]);

    applyEvent(snapshot(''), context);

    expect(textOf(read())).toEqual(['Loaded']);
  });

  it('applies the steps a snapshot replays and skips the frames that are not message content', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    const withGap = snapshot('Hel', { replayEvents: [delta('s0', 'lo')] }) as Extract<
      ChatEvent,
      { type: 'sync' }
    >;
    withGap.data.pendingEvents = [
      { event: 'title', data: { title: 'Named' } },
      { event: 'on_token_usage', data: {} },
      delta('s0', '!'),
    ] as never;

    applyEvent(withGap, context);

    expect(textOf(read())).toEqual(['Hello!']);
  });

  it('rebuilds from a second snapshot without repeating a row or a token', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();

    applyEvent(snapshot('Hel'), context);
    applyEvent(token('s0', 'lo'), context);
    applyEvent({ type: 'error', status: 0 }, context);
    applyEvent(snapshot('Hello wor'), context);
    applyEvent(token('s0', 'ld'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(textOf(read())).toEqual(['Hello world']);
  });

  it('holds steps that arrive before the turn is named, then applies them in order', () => {
    const { applyEvent } = createEventApplier();
    const { context, writes, read } = createList([user]);

    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Hi'), context);
    expect(writes).toHaveLength(0);

    applyEvent(created, context);

    expect(textOf(read())).toEqual(['Hi']);
  });

  it('replaces the optimistic reply instead of adding a second response', () => {
    const optimistic: TMessage = {
      messageId: 'user-1_',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, optimistic]);

    applyEvent(created, context);
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Hi'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(textOf(read())).toEqual(['Hi']);
  });

  it('settles on the final frame and starts the next turn clean', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();

    applyEvent(snapshot('Hel'), context);
    applyEvent(final('Hello, done'), context);
    expect(textOf(read())).toEqual(['Hello, done']);

    applyEvent(token('s0', 'late'), context);
    expect(textOf(read())).toEqual(['Hello, done']);
  });

  describe('with a scheduler', () => {
    const scheduler = () => {
      const queue: Array<() => void> = [];
      const cancelled = jest.fn();
      return {
        cancelled,
        schedule: (flush: () => void) => {
          queue.push(flush);
          return cancelled;
        },
        run: () => queue.splice(0).forEach((flush) => flush()),
        scheduled: () => queue.length,
      };
    };

    it('writes a burst of tokens once, when the scheduled flush runs', () => {
      const frame = scheduler();
      const { applyEvent } = createEventApplier({ schedule: frame.schedule });
      const { context, writes, read } = createList();
      applyEvent(snapshot(''), context);
      const before = writes.length;

      applyEvent(token('s0', 'a'), context);
      applyEvent(token('s0', 'b'), context);
      applyEvent(token('s0', 'c'), context);

      expect(writes).toHaveLength(before);
      expect(frame.scheduled()).toBe(1);
      frame.run();
      expect(writes).toHaveLength(before + 1);
      expect(textOf(read())).toEqual(['abc']);
    });

    it('never lets a held copy of the stream land on top of the final frame', () => {
      const frame = scheduler();
      const { applyEvent } = createEventApplier({ schedule: frame.schedule });
      const { context, read } = createList();
      applyEvent(snapshot(''), context);
      applyEvent(token('s0', 'partial'), context);

      applyEvent(final('whole answer'), context);
      frame.run();

      expect(frame.cancelled).toHaveBeenCalledTimes(1);
      expect(textOf(read())).toEqual(['whole answer']);
    });

    it.each<ChatEvent>([{ type: 'abort' }, { type: 'error', status: 500 }])(
      'writes the held tokens at once when the turn stops ($type)',
      (stop) => {
        const frame = scheduler();
        const { applyEvent } = createEventApplier({ schedule: frame.schedule });
        const { context, read } = createList();
        applyEvent(snapshot(''), context);
        applyEvent(token('s0', 'kept'), context);

        applyEvent(stop, context);

        expect(textOf(read())).toEqual(['kept']);
      },
    );

    it('drops a scheduled write on reset', () => {
      const frame = scheduler();
      const applier = createEventApplier({ schedule: frame.schedule });
      const { context, read } = createList();
      applier.applyEvent(snapshot(''), context);
      applier.applyEvent(token('s0', 'gone'), context);

      applier.reset();
      frame.run();

      expect(textOf(read())).toEqual([]);
    });
  });

  it('reports live status a step carries beside the list', () => {
    const onEffect = jest.fn();
    const { applyEvent } = createEventApplier({ onEffect });
    const { context } = createList();
    applyEvent(snapshot(''), context);

    applyEvent(
      {
        type: 'step',
        data: { event: StepEvents.ON_SANDBOX_STARTING, data: { tool_call_id: 'call-1' } },
      } as ChatEvent,
      context,
    );

    expect(onEffect).toHaveBeenCalledWith({ type: 'sandbox-starting', toolCallId: 'call-1' });
  });
});

describe('a Chat that applies events the way main chat does', () => {
  const createState = (initial: TMessage[]): ChatState => {
    let messages = initial;
    let status: ChatStatus = 'ready';
    return {
      error: undefined,
      connection: 'idle',
      get status() {
        return status;
      },
      set status(next: ChatStatus) {
        status = next;
      },
      get messages() {
        return messages;
      },
      replaceMessages(next) {
        messages = next;
      },
    };
  };

  it('follows a generation it joined late to the same messages, through the real transport', async () => {
    const attachments: Array<{ request: ChatStreamRequest; options: ChatTransportOptions }> = [];
    const wire: WireTransport = {
      send: () => undefined,
      reconnectToStream(request, options) {
        attachments.push({ request, options });
        return { closed: false };
      },
    };
    const state = createState([]);
    const chat = new Chat({
      id: 'thread-1',
      state,
      transport: createGenerationTransport({
        wire: () => wire,
        getStatus: async () => ({ active: true, streamId: 'thread-1', createdAt: 2000 }),
      }),
      prepareRequest: () => {
        throw new Error('view only');
      },
      applyEvent: createEventApplier().applyEvent,
    });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    const resuming = chat.resumeStream();
    await flush();
    const emit = attachments[0].options.onEvent;
    emit({ type: 'open' });
    emit(snapshot('Hel'));
    emit(token('s0', 'lo'));
    await flush();

    expect(chat.status).toBe('streaming');
    expect(textOf(chat.messages)).toEqual(['Hello']);

    emit(final('Hello'));
    await resuming;

    expect(chat.status).toBe('ready');
    expect(chat.messages.map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(textOf(chat.messages)).toEqual(['Hello']);
    chat.dispose();
  });
});
