import {
  StepEvents,
  UsageEvents,
  SteerEvents,
  ContentTypes,
  ApprovalEvents,
  ActivityLabelEvents,
  ReasoningLabelEvents,
} from 'librechat-data-provider';
import type { ChatFrame } from 'librechat-data-provider';
import { normalizeFrame } from '../transport';

/** Frames arrive as parsed JSON; the fixtures only carry the keys under test. */
const frame = (value: object) => value as ChatFrame;

describe('normalizeFrame', () => {
  it('tags the control frames by their keys', () => {
    const created = frame({ created: true, message: { messageId: 'user-1' }, streamId: 's-1' });
    const sync = frame({ sync: true, requestMessage: { messageId: 'user-1' } });
    const final = frame({ final: true, responseMessage: { messageId: 'response-1' } });

    expect(normalizeFrame(created)).toEqual({ type: 'created', data: created });
    expect(normalizeFrame(sync)).toEqual({ type: 'sync', data: sync });
    expect(normalizeFrame(final)).toEqual({ type: 'final', data: final });
  });

  it('keeps a reconcile frame final and leaves the decision to the consumer', () => {
    const reconcile = frame({ final: true, reconcile: true, terminalStatus: 'error' });
    expect(normalizeFrame(reconcile)).toEqual({ type: 'final', data: reconcile });
  });

  it('checks keys in the order the stream hooks always have', () => {
    const finalWithEvent = frame({ final: true, event: StepEvents.ON_RUN_STEP });
    const createdWithSync = frame({ created: true, sync: true, message: {} });
    const eventWithType = frame({ event: 'title', type: ContentTypes.TEXT });

    expect(normalizeFrame(finalWithEvent)?.type).toBe('final');
    expect(normalizeFrame(createdWithSync)?.type).toBe('created');
    expect(normalizeFrame(eventWithType)?.type).toBe('title');
  });

  it('unwraps the named side channels to their payload', () => {
    const cases: Array<[string, string]> = [
      ['attachment', 'attachment'],
      [UsageEvents.ON_CONTEXT_USAGE, 'context_usage'],
      [UsageEvents.ON_TOKEN_USAGE, 'token_usage'],
      [ApprovalEvents.ON_PENDING_ACTION, 'pending_action'],
      [SteerEvents.ON_STEER_APPLIED, 'steer_applied'],
      [SteerEvents.ON_STEER_UPDATED, 'steer_updated'],
      [ActivityLabelEvents.ON_ACTIVITY_LABEL, 'activity_label'],
      [ReasoningLabelEvents.ON_REASONING_LABEL, 'reasoning_label'],
      [ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT, 'reasoning_label_attempt'],
    ];

    for (const [event, type] of cases) {
      const data = { marker: event };
      expect(normalizeFrame(frame({ event, data }))).toEqual({ type, data });
    }
  });

  it('keeps the whole frame for titles, which the title handler reads as-is', () => {
    const title = frame({ event: 'title', data: { conversationId: 'c-1', title: 'Hello' } });
    expect(normalizeFrame(title)).toEqual({ type: 'title', data: title });
  });

  it('treats any other event as a step, including ones the client does not name yet', () => {
    const delta = frame({ event: StepEvents.ON_MESSAGE_DELTA, data: { id: 'step-1' } });
    const unknown = frame({ event: 'on_future_event', data: {} });

    expect(normalizeFrame(delta)).toEqual({ type: 'step', data: delta });
    expect(normalizeFrame(unknown)).toEqual({ type: 'step', data: unknown });
  });

  it('tags legacy content-part and cumulative-text frames', () => {
    const content = frame({ type: ContentTypes.TEXT, text: 'Hi', index: 0, messageId: 'r-1' });
    const text = frame({ message: true, text: 'Hi there', messageId: 'r-1' });

    expect(normalizeFrame(content)).toEqual({ type: 'content', data: content });
    expect(normalizeFrame(text)).toEqual({ type: 'text', data: text });
  });

  it('returns undefined for a frame with none of the keys', () => {
    expect(normalizeFrame(frame({}))).toBeUndefined();
    expect(normalizeFrame(frame({ final: null, created: null }))).toBeUndefined();
  });
});
