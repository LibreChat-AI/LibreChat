import { ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TSubmission,
  TSteerAppliedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import { ResumableRun, ResponsePatcher, ResumableSubscription } from '../resumable';
import { createHost, createScheduler } from '../__fixtures__/resumable';

const response = {
  messageId: 'u-1_',
  parentMessageId: 'u-1',
  conversationId: 'c-1',
  isCreatedByUser: false,
  content: [
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call-1', name: 'search', args: '{}', type: 'tool_call' },
    },
  ],
} as unknown as TMessage;

const submission = {
  userMessage: { messageId: 'u-1', conversationId: 'c-1', isCreatedByUser: true } as TMessage,
  initialResponse: response,
  conversation: { conversationId: 'c-1' },
} as TSubmission;

const setup = (overrides: Partial<TSubmission> = {}) => {
  const clock = createScheduler();
  const host = createHost();
  const run = new ResumableRun(clock.scheduler);
  const target = { ...submission, ...overrides } as TSubmission;
  run.submission = target;
  const sub = new ResumableSubscription(run, host, {
    streamId: 'c-1',
    submission: target,
    isResume: false,
    generationProtocolVersion: 2,
  });
  sub.claim();
  return { clock, host, run, sub, patcher: new ResponsePatcher(sub, host) };
};

const approval = {
  actionId: 'action-1',
  conversationId: 'c-1',
  responseMessageId: 'u-1_',
  payload: {
    type: 'tool_approval',
    action_requests: [{ tool_call_id: 'call-1', name: 'search', arguments: '{}' }],
    review_configs: [{ tool_call_id: 'call-1', allowed_decisions: ['approve', 'reject'] }],
  },
} as unknown as Agents.PendingAction;

describe('ResponsePatcher', () => {
  it('tags the paused tool call with its approval once the response renders', () => {
    const { clock, host, patcher } = setup();
    patcher.applyPendingAction(approval);
    expect(host.pane.setPendingAction).toHaveBeenCalledWith('c-1', approval);
    expect(host.messages.set).not.toHaveBeenCalled();

    host.messages.set([submission.userMessage, response]);
    clock.flushFrames();
    const tagged = host.messages.get()?.[1];
    expect(tagged?.content?.[0]).toMatchObject({
      tool_call: { approval: { actionId: 'action-1' } },
    });
    expect(host.events.syncStepMessage).toHaveBeenCalledWith(tagged);
    expect(clock.frames()).toBe(0);
  });

  it('stops retrying once the subscription is superseded', () => {
    const { clock, run, patcher } = setup();
    patcher.applyPendingAction(approval);
    run.stream = new AbortController();
    clock.flushFrames();
    expect(clock.frames()).toBe(0);
  });

  it('places a steer, settles its chip and marks the draw-in once', () => {
    const { host, patcher, run } = setup();
    host.messages.set([submission.userMessage, response]);
    const placed = { ...response, content: [] } as TMessage;
    (host.steers.resolve as jest.Mock).mockReturnValue(['steer-1']);
    (host.parts.findSteerTarget as jest.Mock).mockReturnValue(1);
    (host.parts.applySteer as jest.Mock).mockReturnValue(placed);
    const event = {
      conversationId: 'c-1',
      steerId: 'steer-1',
      index: 1,
      part: { steerId: 'steer-1' },
    } as unknown as TSteerAppliedEvent;
    patcher.applySteer(event);
    expect(host.steers.resolve).toHaveBeenCalledWith('c-1', 'steer-1', undefined, undefined);
    expect(host.steers.markLiveApplied).toHaveBeenCalledWith('steer-1');
    expect(host.messages.get()?.[1]).toBe(placed);
    expect(run.submission?.initialResponse).toBe(placed);
  });

  it('shifts an activity label past an edited response prefix', () => {
    const { host, patcher } = setup({ editedContent: {}, editPrefixLength: 2 } as TSubmission);
    host.messages.set([submission.userMessage, response]);
    (host.parts.findActivityLabelTarget as jest.Mock).mockReturnValue(1);
    const event = {
      index: 3,
      part: { type: 'activity_label', activity_label_type: 'phase', activity_start_index: 1 },
    } as unknown as TActivityLabelEvent;
    patcher.applyActivityLabel(event);
    expect(host.parts.applyActivityLabel).toHaveBeenCalledWith(
      response,
      expect.objectContaining({
        index: 5,
        part: expect.objectContaining({ activity_start_index: 3 }),
      }),
    );
  });

  it('retries a reasoning label until its think part exists', () => {
    const { clock, host, patcher } = setup();
    host.messages.set([submission.userMessage, response]);
    (host.parts.findReasoningLabelTarget as jest.Mock).mockReturnValue(1);
    patcher.applyReasoningLabel({ index: 0 } as TReasoningLabelEvent);
    expect(clock.frames()).toBe(1);
  });

  it('replays the step events that arrived before created', () => {
    const { host, sub, patcher } = setup();
    const event = { event: 'on_run_step', data: { id: 'step-1' } } as never;
    sub.preCreatedStepEvents.push(event);
    patcher.replayPreCreatedStepEvents();
    expect(host.events.stepHandler).toHaveBeenCalledWith(event, sub.liveSubmission());
    expect(sub.preCreatedStepEvents).toHaveLength(0);
  });
});
