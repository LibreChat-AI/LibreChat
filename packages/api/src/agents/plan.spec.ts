import type { ResolveAgentTurnExecutionPlanInput } from './plan';
import { resolveAgentTurnExecutionPlan } from './plan';

const baseInput = (): ResolveAgentTurnExecutionPlanInput => ({
  conversationId: 'conversation-1',
  parentMessageId: 'message-1',
  isNewConversation: false,
  canPause: false,
  durableEventActorSuspensions: false,
});

const boundEvent = () => ({
  type: 'game.turn.ready',
  binding: {
    bindingId: 'binding-1',
    parentConversationId: 'parent-conversation',
  },
  expectedAction: { toolName: 'submit_move' },
});

describe('resolveAgentTurnExecutionPlan', () => {
  it.each([
    ['user', {}, 'user'],
    ['subagent', { isSubagent: true }, 'subagent'],
    ['completion', { event: { type: 'subagent.completion' } }, 'completion'],
    ['schedule', { isSchedule: true }, 'schedule'],
    ['event', { isEvent: true }, 'event'],
    ['resume', { isResume: true }, 'resume'],
  ] as const)('classifies a %s turn from trusted request facts', (_label, overrides, origin) => {
    expect(resolveAgentTurnExecutionPlan({ ...baseInput(), ...overrides }).origin).toBe(origin);
  });

  it('starts fresh only for a new conversation', () => {
    expect(
      resolveAgentTurnExecutionPlan({ ...baseInput(), isNewConversation: true }).strategy,
    ).toBe('fresh');
  });

  it('attempts a checkpoint for a compatible authenticated bound event', () => {
    expect(resolveAgentTurnExecutionPlan({ ...baseInput(), event: boundEvent() })).toEqual({
      origin: 'event',
      strategy: 'checkpoint',
      conversationId: 'conversation-1',
      parentMessageId: 'message-1',
      canPause: false,
      expectedAction: { toolName: 'submit_move' },
      binding: {
        bindingId: 'binding-1',
        parentConversationId: 'parent-conversation',
      },
    });
  });

  it('keeps a pause-capable bound event on checkpoint continuation', () => {
    expect(
      resolveAgentTurnExecutionPlan({
        ...baseInput(),
        event: boundEvent(),
        canPause: true,
        durableEventActorSuspensions: true,
      }).strategy,
    ).toBe('checkpoint');
  });

  it.each([
    ['no binding', { event: { ...boundEvent(), binding: undefined } }],
    ['no expected action', { event: { ...boundEvent(), expectedAction: undefined } }],
    ['memory checkpointer', { event: boundEvent(), checkpointerType: 'memory' }],
    [
      'pre-capability pause consumer fleet',
      { event: boundEvent(), canPause: true, durableEventActorSuspensions: false },
    ],
  ] as const)('falls back to history for %s', (_label, overrides) => {
    expect(resolveAgentTurnExecutionPlan({ ...baseInput(), ...overrides }).strategy).toBe(
      'history',
    );
  });

  it('returns a frozen plan', () => {
    expect(Object.isFrozen(resolveAgentTurnExecutionPlan(baseInput()))).toBe(true);
  });
});
