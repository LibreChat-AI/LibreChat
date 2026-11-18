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

  it('starts a regeneration beside the saved answer instead of carrying on from it', () => {
    const saved: TMessage = {
      messageId: 'resp-0',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.TEXT, text: 'Earlier answer' }],
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, saved]);

    applyEvent(created, context);
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Hi'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-0', 'resp-1']);
    expect(textOf(read())).toEqual(['Hi']);
    expect(read()[1]).toBe(saved);
    expect(read()[2].parentMessageId).toBe('user-1');
  });

  it('leaves the leaf a compaction names as it is and starts the summary under it', () => {
    const leaf: TMessage = {
      messageId: 'resp-0',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.TEXT, text: 'Earlier answer' }],
    };
    const anchor: ChatEvent = {
      type: 'created',
      data: {
        created: true,
        message: {
          messageId: 'resp-0',
          conversationId: 'thread-1',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          text: '',
        },
      },
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, leaf]);

    applyEvent(anchor, context);
    expect(read()).toEqual([user, leaf]);
    expect(read()[1]).toBe(leaf);

    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Summary'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-0', 'resp-1']);
    expect(read()[1]).toBe(leaf);
    expect(read()[2]).toMatchObject({ parentMessageId: 'resp-0', isCreatedByUser: false });
    expect(textOf(read())).toEqual(['Summary']);
  });

  it('keeps the text of a user leaf a compaction names', () => {
    const anchor: ChatEvent = {
      type: 'created',
      data: { created: true, message: { ...user, text: '' } },
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user]);

    applyEvent(anchor, context);
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Summary'), context);

    expect(read()[0]).toBe(user);
    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(read()[1].parentMessageId).toBe('user-1');
  });

  it('settles a compaction on a user leaf without blanking the leaf', () => {
    const anchor = { ...user, text: '' };
    const settled: ChatEvent = {
      type: 'final',
      data: {
        final: true,
        conversation: { conversationId: 'thread-1' },
        requestMessage: anchor,
        responseMessage: {
          messageId: 'resp-1',
          conversationId: 'thread-1',
          parentMessageId: 'user-1',
          isCreatedByUser: false,
          text: '',
          content: [{ type: ContentTypes.TEXT, text: 'Summary, done' }],
        },
      },
    } as ChatEvent;
    const watched = createEventApplier();
    const first = createList([user]);
    watched.applyEvent(
      { type: 'created', data: { created: true, message: anchor } },
      first.context,
    );
    watched.applyEvent(opened('s0', 0), first.context);
    watched.applyEvent(token('s0', 'Summary'), first.context);
    watched.applyEvent(settled, first.context);

    expect(first.read()[0]).toBe(user);
    expect(textOf(first.read())).toEqual(['Summary, done']);

    /** A chat that saw only the final frame recognizes the anchor from the frame itself. */
    const late = createEventApplier();
    const second = createList([user]);
    late.applyEvent(settled, second.context);

    expect(second.read()[0]).toBe(user);
    expect(textOf(second.read())).toEqual(['Summary, done']);
  });

  it('keeps the user turn a regeneration snapshot placed on an empty list', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();

    applyEvent(snapshot('Hel', { isRegenerate: true }), context);
    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);

    applyEvent(token('s0', 'lo'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(textOf(read())).toEqual(['Hello']);
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

describe('side frames', () => {
  const toolOpened = (id: string, index: number, callId: string): ChatEvent =>
    ({
      type: 'step',
      data: {
        event: StepEvents.ON_RUN_STEP,
        data: {
          id,
          runId: 'resp-1',
          index,
          type: StepTypes.TOOL_CALLS,
          stepDetails: {
            type: StepTypes.TOOL_CALLS,
            tool_calls: [{ id: callId, name: 'search', args: '', type: 'tool_call' }],
          },
          usage: null,
        },
      },
    }) as ChatEvent;

  const thought = (id: string, think: string): ChatEvent =>
    ({
      type: 'step',
      data: {
        event: StepEvents.ON_REASONING_DELTA,
        data: { id, delta: { content: [{ type: ContentTypes.THINK, think }] } },
      },
    }) as ChatEvent;

  const steerPart = {
    type: ContentTypes.STEER,
    [ContentTypes.STEER]: 'Go deeper',
    steerId: 'steer-1',
  };
  const steered = (index: number): ChatEvent =>
    ({
      type: 'steer_applied',
      data: { steerId: 'steer-1', index, responseMessageId: 'resp-1', part: steerPart },
    }) as ChatEvent;

  const labelled = (index: number): ChatEvent =>
    ({
      type: 'activity_label',
      data: {
        index,
        responseMessageId: 'resp-1',
        part: { type: ContentTypes.ACTIVITY_LABEL, [ContentTypes.ACTIVITY_LABEL]: 'Searching' },
      },
    }) as ChatEvent;

  const titled: ChatEvent = {
    type: 'reasoning_label',
    data: {
      index: 0,
      stepId: 'reasoning-1',
      revision: 1,
      label: 'Weighing sources',
      status: 'streaming',
      responseMessageId: 'resp-1',
    },
  } as ChatEvent;

  const pause = (...callIds: string[]): Agents.PendingAction =>
    ({
      actionId: 'action-1',
      conversationId: 'thread-1',
      responseMessageId: 'resp-1',
      payload: {
        type: 'tool_approval',
        action_requests: callIds.map((id) => ({
          tool_call_id: id,
          name: 'search',
          arguments: '{}',
        })),
        review_configs: callIds.map((id) => ({
          tool_call_id: id,
          allowed_decisions: ['approve', 'reject'],
        })),
      },
    }) as unknown as Agents.PendingAction;
  const paused = (...callIds: string[]): ChatEvent => ({
    type: 'pending_action',
    data: pause(...callIds),
  });

  const parts = (messages: TMessage[]) => response(messages)?.content ?? [];
  const approvalOf = (part: unknown) =>
    (part as { tool_call?: { approval?: { actionId?: string } } } | undefined)?.tool_call?.approval
      ?.actionId;

  it('places an injected steer at the index the server claimed, between what streams around it', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    applyEvent(snapshot('Before'), context);

    applyEvent(steered(1), context);
    applyEvent(opened('s2', 2), context);
    applyEvent(token('s2', 'After'), context);

    expect(parts(read())[1]).toEqual(steerPart);
    expect(textOf(read())).toEqual(['Before', undefined, 'After']);
  });

  it('writes a replayed steer once', () => {
    const { applyEvent } = createEventApplier();
    const { context, writes, read } = createList();
    applyEvent(snapshot('Before'), context);
    applyEvent(steered(1), context);
    const before = writes.length;

    applyEvent(steered(1), context);

    expect(writes).toHaveLength(before);
    expect(parts(read())).toHaveLength(2);
  });

  it('keeps a steer injected before the first run step when that step renames the reply', () => {
    const optimistic: TMessage = {
      messageId: 'user-1_',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [],
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, optimistic]);
    applyEvent(created, context);

    applyEvent(steered(0), context);
    expect(read()[1]).toMatchObject({ messageId: 'user-1_', content: [steerPart] });

    applyEvent(opened('s1', 1), context);
    applyEvent(token('s1', 'On it'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(parts(read())[0]).toEqual(steerPart);
    expect(textOf(read())).toEqual([undefined, 'On it']);
  });

  it('keeps a steer placed on the placeholder of a regeneration, which seeds from the submission', () => {
    const saved: TMessage = {
      messageId: 'resp-0',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [{ type: ContentTypes.TEXT, text: 'Earlier answer' }],
    };
    const optimistic: TMessage = {
      messageId: 'user-1_',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [],
    };
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, saved, optimistic]);
    applyEvent(created, context);

    applyEvent(steered(0), context);
    expect(read()[2]).toMatchObject({ messageId: 'user-1_', content: [steerPart] });

    applyEvent(opened('s1', 1), context);
    applyEvent(token('s1', 'On it'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-0', 'resp-1']);
    expect(parts(read())[0]).toEqual(steerPart);
    expect(textOf(read())).toEqual([undefined, 'On it']);
  });

  it('holds a steer that arrives before the turn is named, then places it', () => {
    const optimistic: TMessage = {
      messageId: 'user-1_',
      conversationId: 'thread-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      text: '',
      content: [],
    };
    const { applyEvent } = createEventApplier();
    const { context, writes, read } = createList([user, optimistic]);

    applyEvent(steered(0), context);
    expect(writes).toHaveLength(0);

    applyEvent(created, context);

    expect(read()[1]).toMatchObject({ messageId: 'user-1_', content: [steerPart] });
  });

  it('drops a frame that was waiting when a snapshot arrives, since the snapshot holds it', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();

    applyEvent(steered(1), context);
    applyEvent(snapshot('Before'), context);

    expect(parts(read())).toHaveLength(1);
  });

  it('places an activity label at its claimed index beside the tools it heads', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    applyEvent(snapshot('Looking'), context);
    applyEvent(toolOpened('t1', 2, 'call-1'), context);

    applyEvent(labelled(1), context);

    expect(parts(read())[1]).toMatchObject({ type: ContentTypes.ACTIVITY_LABEL });
    expect(parts(read())[2]).toMatchObject({ type: ContentTypes.TOOL_CALL });
  });

  it('titles a reasoning part that is drawn after its title arrives', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    applyEvent(snapshot(''), context);

    applyEvent(titled, context);
    expect(parts(read())[0]).toBeUndefined();

    applyEvent(thought('s0', 'Comparing the two reports'), context);

    expect(parts(read())[0]).toMatchObject({
      type: ContentTypes.THINK,
      think: 'Comparing the two reports',
      reasoning_label: 'Weighing sources',
    });
  });

  it('draws a pause on its tool call, and on a sibling call drawn later', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    applyEvent(snapshot('Checking'), context);
    applyEvent(toolOpened('t1', 1, 'call-1'), context);

    applyEvent(paused('call-1', 'call-2'), context);
    expect(approvalOf(parts(read())[1])).toBe('action-1');

    applyEvent(toolOpened('t2', 2, 'call-2'), context);

    expect(approvalOf(parts(read())[2])).toBe('action-1');
  });

  it('draws the pause a snapshot was taken under', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    const call = {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call-1', name: 'search', args: '{}', type: 'tool_call' },
    };
    const withPause = snapshot('', {
      aggregatedContent: [call] as never,
      runSteps: [],
      pendingAction: pause('call-1') as never,
    });

    applyEvent(withPause, context);

    expect(approvalOf(parts(read())[0])).toBe('action-1');
  });

  it('draws a pending OAuth prompt as its tool call, once, with the sign-in link', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    const oauthStep = {
      id: 'oauth-step',
      runId: 'resp-1',
      index: 1,
      type: StepTypes.TOOL_CALLS,
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_github', args: '', type: 'tool_call' }],
      },
      usage: null,
    };
    const withPrompt = snapshot('Signing in', {
      runSteps: [runStep('s0', 0), oauthStep] as never,
      pendingOAuthPrompts: [
        {
          stepId: 'oauth-step',
          runId: 'resp-1',
          index: 1,
          toolCallId: 'call-oauth',
          toolName: 'oauth_mcp_github',
          authURL: 'https://example.test/authorize',
        },
      ],
    });

    applyEvent(withPrompt, context);

    expect(parts(read())).toHaveLength(2);
    expect(parts(read())[1]).toMatchObject({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call-oauth', auth: 'https://example.test/authorize' },
    });
  });

  it('keeps the live sign-in link over one a replayed step event still carries', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    const withStaleLink = snapshot('Signing in', {
      pendingOAuthPrompts: [
        {
          stepId: 'oauth-step',
          runId: 'resp-1',
          index: 1,
          toolCallId: 'call-oauth',
          toolName: 'oauth_mcp_github',
          authURL: 'https://example.test/authorize',
        },
      ],
      replayEvents: [
        {
          event: StepEvents.ON_RUN_STEP_DELTA,
          data: {
            id: 'oauth-step',
            delta: {
              type: StepTypes.TOOL_CALLS,
              tool_calls: [{ id: 'call-oauth', name: 'oauth_mcp_github', args: '' }],
              auth: 'https://example.test/replaced',
            },
          },
        },
      ],
    });

    applyEvent(withStaleLink, context);

    expect(parts(read())[1]).toMatchObject({
      tool_call: { id: 'call-oauth', auth: 'https://example.test/authorize' },
    });
  });

  it('places the side frames a snapshot replays, in order with its steps', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    const withGap = snapshot('Before', {
      replayEvents: [{ event: 'on_steer_applied', data: (steered(1) as { data: object }).data }],
    }) as Extract<ChatEvent, { type: 'sync' }>;
    withGap.data.pendingEvents = [
      { event: StepEvents.ON_RUN_STEP, data: runStep('s2', 2) },
      delta('s2', 'After'),
    ] as never;

    applyEvent(withGap, context);

    expect(parts(read())[1]).toEqual(steerPart);
    expect(textOf(read())).toEqual(['Before', undefined, 'After']);
  });

  it('forgets a frame still waiting when the turn ends', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList();
    applyEvent(snapshot('Done'), context);
    applyEvent(
      {
        type: 'steer_applied',
        data: { ...(steered(1) as { data: object }).data, responseMessageId: 'other' },
      } as ChatEvent,
      context,
    );

    applyEvent(final('Done'), context);
    applyEvent(snapshot('Done'), context);

    expect(parts(read())).toHaveLength(1);
  });

  describe('with a scheduler', () => {
    const frames = () => {
      const queue: Array<() => void> = [];
      return {
        schedule: (flush: () => void) => {
          queue.push(flush);
          return () => undefined;
        },
        run: () => queue.splice(0).forEach((flush) => flush()),
      };
    };

    it('lands the held tokens before placing, so neither is lost', () => {
      const frame = frames();
      const { applyEvent } = createEventApplier({ schedule: frame.schedule });
      const { context, read } = createList();
      applyEvent(snapshot('Be'), context);
      applyEvent(token('s0', 'fore'), context);

      applyEvent(steered(1), context);
      applyEvent(token('s0', '!'), context);
      frame.run();

      expect(parts(read())[1]).toEqual(steerPart);
      expect(textOf(read())[0]).toBe('Before!');
    });

    it('does not write per token while a frame waits on a part that is not drawn', () => {
      const frame = frames();
      const { applyEvent } = createEventApplier({ schedule: frame.schedule });
      const { context, writes, read } = createList();
      applyEvent(snapshot('a'), context);
      applyEvent(titled, context);
      const before = writes.length;

      applyEvent(token('s0', 'b'), context);
      applyEvent(token('s0', 'c'), context);
      applyEvent(token('s0', 'd'), context);

      expect(writes).toHaveLength(before);
      frame.run();
      expect(writes).toHaveLength(before + 1);
      expect(textOf(read())[0]).toBe('abcd');
    });
  });
});

describe('a turn whose shape the server states', () => {
  const reply = (id: string, texts: string[]): TMessage => ({
    messageId: id,
    conversationId: 'thread-1',
    parentMessageId: 'user-1',
    isCreatedByUser: false,
    text: '',
    content: texts.map((text) => ({ type: ContentTypes.TEXT, text })),
  });
  const createdAs = (turn: object): ChatEvent =>
    ({ type: 'created', data: { created: true, message: user, turn } }) as ChatEvent;
  const texts = (messages: TMessage[], id: string) =>
    (messages.find((message) => message.messageId === id)?.content ?? []).map(
      (part) => (part as { text?: string } | undefined)?.text,
    );

  it('draws a continued reply again from empty under its own id, not as a second answer', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, reply('resp-1', ['Stopped here'])]);

    applyEvent(
      createdAs({ responseMessageId: 'resp-1', sourceMessageId: 'resp-1', isContinued: true }),
      context,
    );
    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(texts(read(), 'resp-1')).toEqual([]);

    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Stopped here, then carried on'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-1']);
    expect(texts(read(), 'resp-1')).toEqual(['Stopped here, then carried on']);
  });

  it('continues the reply it was told to, not the answer that happens to be last in the list', () => {
    const sibling = reply('resp-9', ['Another branch']);
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, reply('resp-1', ['Stopped here']), sibling]);

    applyEvent(
      createdAs({ responseMessageId: 'resp-1', sourceMessageId: 'resp-1', isContinued: true }),
      context,
    );
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Carried on'), context);

    expect(texts(read(), 'resp-1')).toEqual(['Carried on']);
    expect(read().find((message) => message.messageId === 'resp-9')).toBe(sibling);
  });

  it('reruns an edited reply from its own parts under the new id the server stores it at', () => {
    const saved = reply('resp-0', ['Kept', 'Before the edit']);
    const sibling = reply('resp-9', ['Another branch']);
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, saved, sibling]);

    applyEvent(
      createdAs({
        /** An edited rerun gets a fresh id; the reply it starts from is named beside it. */
        responseMessageId: 'resp-1',
        sourceMessageId: 'resp-0',
        editedContent: { index: 1, type: ContentTypes.TEXT, text: 'After the edit' },
      }),
      context,
    );
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', ' and on'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-9', 'resp-1']);
    const drawn = texts(read(), 'resp-1').join('|');
    expect(drawn).toContain('Kept');
    expect(drawn).toContain('After the edit');
    expect(drawn).toContain(' and on');
    expect(drawn).not.toContain('Before the edit');
    expect(drawn).not.toContain('Another branch');
    /** The saved row's own parts are not the ones edited, and the other branch is untouched. */
    expect(texts([saved], 'resp-0')).toEqual(['Kept', 'Before the edit']);
    expect(read().find((message) => message.messageId === 'resp-9')).toBe(sibling);
  });

  it("takes a regeneration at the server's word where the list holds no earlier answer", () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([
      user,
      { ...reply('resp-0', ['Other branch']), parentMessageId: 'user-0' },
    ]);

    applyEvent(createdAs({ responseMessageId: 'resp-1', isRegenerate: true }), context);
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Again'), context);

    /** Not seeded from the reply at the tail, which a plain turn would carry on from. */
    expect(texts(read(), 'resp-1')).toEqual(['Again']);
    expect(texts(read(), 'resp-0')).toEqual(['Other branch']);
  });

  it('reads a frame without a stated shape by what the list implies, as before', () => {
    const { applyEvent } = createEventApplier();
    const { context, read } = createList([user, reply('resp-0', ['Earlier answer'])]);

    applyEvent(created, context);
    applyEvent(opened('s0', 0), context);
    applyEvent(token('s0', 'Hi'), context);

    expect(read().map((message) => message.messageId)).toEqual(['user-1', 'resp-0', 'resp-1']);
  });
});

describe('state beside the message list', () => {
  /** Main chat's handlers for that state, recording what they are called with and in what order. */
  const record = () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const log =
      (name: string, result?: unknown) =>
      (...args: unknown[]): unknown => {
        calls.push([name, ...args]);
        return result;
      };
    const init = {
      usage: {
        bindResponse: log('bindResponse'),
        contextHandler: log('context'),
        usageHandler: log('usage'),
        tapStream: log('tap'),
        tapContent: log('tapContent'),
        finalizeUsage: log('finalize'),
        backfillUsage: log('backfill'),
        seedLiveFromContent: log('seedLive'),
      },
      onAttachment: log('attachment'),
      onTitle: log('title'),
      steers: {
        resolve: log('resolve', ['steer-1']),
        markLiveApplied: log('markLive'),
        update: log('update'),
        seed: log('seed'),
        settleApplied: log('settle'),
      },
    } as unknown as Parameters<typeof createEventApplier>[0];
    return { calls, init, names: () => calls.map(([name]) => name) };
  };

  const context: ChatEvent = {
    type: 'context_usage',
    data: { breakdown: { maxContextTokens: 1000 } },
  } as ChatEvent;
  const usage: ChatEvent = { type: 'token_usage', data: { output_tokens: 5 } } as ChatEvent;
  const attachment: ChatEvent = {
    type: 'attachment',
    data: { messageId: 'resp-1', file_id: 'file-1', filename: 'chart.png' },
  } as ChatEvent;
  const title: ChatEvent = {
    type: 'title',
    data: { event: 'title', data: { conversationId: 'thread-1', title: 'A title' } },
  };
  const relabel: ChatEvent = {
    type: 'steer_updated',
    data: { conversationId: 'thread-1', steers: [] },
  };

  it('gives each live frame to the handler main chat gives it, bound to the turn', () => {
    const { calls, init, names } = record();
    const { applyEvent } = createEventApplier(init);
    const { context: ctx } = createList();

    for (const event of [
      created,
      opened('s0', 0),
      token('s0', 'Hi'),
      context,
      usage,
      attachment,
      title,
      relabel,
      final('Hi'),
    ]) {
      applyEvent(event, ctx);
    }

    expect(names()).toEqual([
      'bindResponse',
      'tap',
      'context',
      'usage',
      'attachment',
      'title',
      'update',
      'finalize',
    ]);
    const turn = expect.objectContaining({
      userMessage: expect.objectContaining({ messageId: 'user-1' }),
    });
    expect(calls[2]).toEqual(['context', (context as { data: unknown }).data, turn]);
    expect(calls[3]).toEqual(['usage', (usage as { data: unknown }).data, turn]);
    expect(calls[4]).toEqual([
      'attachment',
      { data: (attachment as { data: unknown }).data, submission: turn },
    ]);
    expect(calls[5]).toEqual(['title', (title as { data: unknown }).data]);
    expect(calls[7]).toEqual(['finalize', (final('Hi') as { data: unknown }).data, turn]);
  });

  it('rebuilds what a late joiner missed from the snapshot, then applies what it carries', () => {
    const { calls, init, names } = record();
    const { applyEvent } = createEventApplier(init);
    const { context: ctx } = createList();
    const collected = [{ output_tokens: 3 }];
    const reading = { breakdown: { maxContextTokens: 1000 } };
    const pending = [{ steerId: 'steer-2', text: 'Later' }];

    applyEvent(
      snapshot('Hel', {
        collectedUsage: collected,
        contextUsage: reading,
        pendingSteers: pending,
        titleEvent: { event: 'title', data: { title: 'A title' } },
        replayEvents: [
          { event: 'on_token_usage', data: { output_tokens: 1 } },
          { event: 'attachment', data: { messageId: 'resp-1', file_id: 'file-1' } },
        ],
      } as Partial<Agents.ResumeState>),
      ctx,
    );

    expect(names()).toEqual([
      'bindResponse',
      'backfill',
      'context',
      'seedLive',
      'seed',
      'settle',
      'title',
      'usage',
      'attachment',
    ]);
    expect(calls[1][1]).toBe(collected);
    expect(calls[2][1]).toBe(reading);
    expect(calls[3][1]).toEqual([{ type: ContentTypes.TEXT, text: 'Hel' }]);
    expect(calls[4].slice(0, 3)).toEqual(['seed', 'thread-1', pending]);
    expect(calls[5]).toEqual(['settle', 'thread-1', [{ type: ContentTypes.TEXT, text: 'Hel' }]]);
  });

  it('clears chips with an empty snapshot list, which a steer taken while away would strand', () => {
    const { calls, init } = record();
    const { applyEvent } = createEventApplier(init);
    const { context: ctx } = createList();

    applyEvent(snapshot('Hel'), ctx);

    expect(calls.find(([name]) => name === 'seed')).toEqual(['seed', 'thread-1', []]);
  });

  it('settles a steer chip as soon as the server says it was taken, and marks its part as drawn', () => {
    const { calls, init, names } = record();
    const { applyEvent } = createEventApplier(init);
    const { context: ctx, read } = createList();
    const part = {
      type: ContentTypes.STEER,
      [ContentTypes.STEER]: 'Go deeper',
      steerId: 'steer-1',
    };
    const taken = {
      type: 'steer_applied',
      data: {
        steerId: 'steer-1',
        clientSteerId: 'client-1',
        index: 1,
        responseMessageId: 'resp-1',
        part,
      },
    } as ChatEvent;

    applyEvent(created, ctx);
    /** Its response is not drawn yet, so the part waits; the chip does not. */
    applyEvent(taken, ctx);
    expect(names()).toEqual(['bindResponse', 'resolve']);
    expect(calls[1]).toEqual(['resolve', 'thread-1', 'steer-1', 'client-1', undefined]);

    applyEvent(opened('s0', 0), ctx);
    applyEvent(token('s0', 'Hi'), ctx);

    expect(names().filter((name) => name !== 'tap')).toEqual([
      'bindResponse',
      'resolve',
      'markLive',
    ]);
    expect(calls.find(([name]) => name === 'markLive')).toEqual(['markLive', 'steer-1']);
    expect(read()[1].content?.[1]).toEqual(part);
  });

  it('holds a frame that needs its turn until a frame names the turn', () => {
    const { calls, init, names } = record();
    const { applyEvent } = createEventApplier(init);
    const { context: ctx } = createList();

    applyEvent(attachment, ctx);
    applyEvent(usage, ctx);
    expect(names()).toEqual([]);

    applyEvent(created, ctx);

    expect(names()).toEqual(['bindResponse', 'attachment', 'usage']);
    expect(calls[1][1]).toMatchObject({ data: { file_id: 'file-1' } });
  });

  it('keeps no such state where no handler is given, and still applies the messages', () => {
    const { applyEvent } = createEventApplier();
    const { context: ctx, read } = createList();

    for (const event of [created, opened('s0', 0), token('s0', 'Hi'), usage, attachment, title]) {
      applyEvent(event, ctx);
    }

    expect(textOf(read())).toEqual(['Hi']);
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
