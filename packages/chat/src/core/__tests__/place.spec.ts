import { StepTypes, StepEvents, ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TSteerAppliedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import {
  placeSteer,
  oauthPromptSteps,
  placeActivityLabel,
  placePendingAction,
  placeReasoningLabel,
} from '../parts/place';

const user = { messageId: 'u-1', conversationId: 'c-1', isCreatedByUser: true } as TMessage;

const toolCall = (id: string) => ({
  type: ContentTypes.TOOL_CALL,
  tool_call: { id, name: 'search', args: '{}', type: 'tool_call' },
});

const response = (content: unknown[], messageId = 'r-1'): TMessage =>
  ({
    messageId,
    parentMessageId: 'u-1',
    conversationId: 'c-1',
    isCreatedByUser: false,
    content,
  }) as unknown as TMessage;

const steer = (index: number, extra: Partial<TSteerAppliedEvent> = {}): TSteerAppliedEvent =>
  ({
    steerId: 'steer-1',
    index,
    responseMessageId: 'r-1',
    part: { type: ContentTypes.STEER, [ContentTypes.STEER]: 'Go deeper', steerId: 'steer-1' },
    ...extra,
  }) as TSteerAppliedEvent;

const label = (index: number, part: object = {}): TActivityLabelEvent =>
  ({
    index,
    responseMessageId: 'r-1',
    part: {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Searching',
      ...part,
    },
  }) as unknown as TActivityLabelEvent;

const title = (index: number): TReasoningLabelEvent =>
  ({
    index,
    stepId: 'reasoning-1',
    revision: 1,
    label: 'Weighing sources',
    status: 'streaming',
    responseMessageId: 'r-1',
  }) as TReasoningLabelEvent;

const approval = (...callIds: string[]): Agents.PendingAction =>
  ({
    actionId: 'action-1',
    conversationId: 'c-1',
    responseMessageId: 'r-1',
    payload: {
      type: 'tool_approval',
      action_requests: callIds.map((id) => ({ tool_call_id: id, name: 'search', arguments: '{}' })),
      review_configs: callIds.map((id) => ({
        tool_call_id: id,
        allowed_decisions: ['approve', 'reject'],
      })),
    },
  }) as unknown as Agents.PendingAction;

describe('placing a steer', () => {
  it('reports nothing when the response is not in the list', () => {
    expect(placeSteer([user], steer(1))).toBeUndefined();
  });

  it('writes the part at the index the server claimed', () => {
    const messages = [user, response([toolCall('call-1')])];
    const placement = placeSteer(messages, steer(1));

    expect(placement).toMatchObject({ index: 1, changed: true, settled: true });
    expect(placement?.message.content?.[1]).toEqual(steer(1).part);
    expect(messages[1].content).toHaveLength(1);
  });

  it('finds the response under the placeholder it is still drawn as', () => {
    const messages = [user, response([], 'u-1_')];
    const placement = placeSteer(messages, steer(0), { placeholderIds: ['u-1_'] });

    expect(placement?.index).toBe(1);
  });

  it("shifts past an edit's retained prefix", () => {
    const messages = [user, response([{ type: ContentTypes.TEXT, text: 'kept' }])];
    const placement = placeSteer(messages, steer(0), { prefixLength: 1 });

    expect(placement?.message.content?.[0]).toEqual({ type: ContentTypes.TEXT, text: 'kept' });
    expect(placement?.message.content?.[1]).toEqual(steer(0).part);
  });

  it('keeps the same message when the part is already there', () => {
    const messages = [user, response([steer(0).part])];
    const placement = placeSteer(messages, steer(0));

    expect(placement).toMatchObject({ changed: false, settled: true });
    expect(placement?.message).toBe(messages[1]);
  });
});

describe('placing an activity label', () => {
  it('writes the label where the server claimed, with no prefix to shift past', () => {
    const messages = [user, response([toolCall('call-1')])];
    const placement = placeActivityLabel(messages, label(1));

    expect(placement).toMatchObject({ index: 1, changed: true });
    expect(placement?.message.content?.[1]).toMatchObject({ type: ContentTypes.ACTIVITY_LABEL });
  });

  it('shifts the label and its phase bounds by the same prefix as the tools it heads', () => {
    const messages = [user, response([{ type: ContentTypes.TEXT, text: 'kept' }, null])];
    const placement = placeActivityLabel(
      messages,
      label(3, { activity_label_type: 'phase', activity_start_index: 1, activity_end_index: 2 }),
      { prefixLength: 2 },
    );

    expect(placement?.message.content?.[3]).toBeUndefined();
    expect(placement?.message.content?.[5]).toMatchObject({
      activity_start_index: 3,
      activity_end_index: 4,
    });
  });

  it("starts a phase one part earlier only when the generation's first part merged into the prefix", () => {
    const kept = { type: ContentTypes.TEXT, text: 'kept' };
    const messages = [user, response([kept, toolCall('call-1')])];
    const phase = label(2, { activity_label_type: 'phase', activity_start_index: 0 });

    const merged = placeActivityLabel(messages, phase, { prefixLength: 1, foldedFirstPart: true });
    const separate = placeActivityLabel(messages, phase, { prefixLength: 1 });

    expect(merged?.message.content?.[3]).toMatchObject({ activity_start_index: 0 });
    expect(separate?.message.content?.[3]).toMatchObject({ activity_start_index: 1 });
  });
});

describe('placing a reasoning label', () => {
  it('is unsettled while the reasoning part has not been drawn', () => {
    const messages = [user, response([toolCall('call-1')])];
    const placement = placeReasoningLabel(messages, title(0));

    expect(placement).toMatchObject({ changed: false, settled: false });
  });

  it('titles the reasoning part once it is there', () => {
    const messages = [user, response([{ type: ContentTypes.THINK, think: 'Comparing' }])];
    const placement = placeReasoningLabel(messages, title(0));

    expect(placement).toMatchObject({ changed: true, settled: true });
    expect(placement?.message.content?.[0]).toMatchObject({ reasoning_label: 'Weighing sources' });
  });

  it('is settled when the same title arrives again', () => {
    const messages = [user, response([{ type: ContentTypes.THINK, think: 'Comparing' }])];
    const first = placeReasoningLabel(messages, title(0));
    const again = placeReasoningLabel([user, first!.message], title(0));

    expect(again).toMatchObject({ changed: false, settled: true });
  });
});

describe('placing a pause', () => {
  it('reports nothing when the response it interrupts is not in the list', () => {
    expect(placePendingAction([user], approval('call-1'))).toBeUndefined();
  });

  it('is settled once every paused call carries the approval', () => {
    const messages = [user, response([toolCall('call-1'), toolCall('call-2')])];
    const placement = placePendingAction(messages, approval('call-1', 'call-2'));

    expect(placement).toMatchObject({ changed: true, settled: true });
  });

  it('is unsettled while one of the paused calls has not been drawn', () => {
    const messages = [user, response([toolCall('call-1')])];
    const placement = placePendingAction(messages, approval('call-1', 'call-2'));

    expect(placement).toMatchObject({ changed: true, settled: false });
  });
});

describe('a pending OAuth prompt', () => {
  it('becomes the run step and the delta that draw its tool call', () => {
    const steps = oauthPromptSteps({
      stepId: 'step-1',
      runId: 'r-1',
      index: 2,
      toolCallId: 'call-1',
      toolName: 'oauth_mcp_github',
      authURL: 'https://example.test/authorize',
      expiresAt: 5,
    });

    expect(steps.map((step) => step.event)).toEqual([
      StepEvents.ON_RUN_STEP,
      StepEvents.ON_RUN_STEP_DELTA,
    ]);
    expect(steps[0].data).toMatchObject({
      id: 'step-1',
      runId: 'r-1',
      index: 2,
      stepDetails: { type: StepTypes.TOOL_CALLS, tool_calls: [{ id: 'call-1' }] },
    });
    expect(steps[1].data).toMatchObject({
      id: 'step-1',
      delta: { auth: 'https://example.test/authorize', expires_at: 5 },
    });
  });
});
