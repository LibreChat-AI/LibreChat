import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TReasoningLabelEvent } from 'librechat-data-provider';
import { applyReasoningLabel, findReasoningLabelMessageIndex } from '../reasoningLabels';

const baseEvent: TReasoningLabelEvent = {
  index: 0,
  stepId: 'reasoning-1',
  revision: 1,
  label: 'Tracing resume ownership',
  status: 'streaming',
  responseMessageId: 'response-1',
};

function response(): TMessage {
  return {
    messageId: 'response-1',
    conversationId: 'conversation-1',
    parentMessageId: 'user-1',
    sender: 'Agent',
    text: '',
    isCreatedByUser: false,
    content: [{ type: ContentTypes.THINK, think: 'Visible reasoning' }],
  };
}

describe('reasoning label utilities', () => {
  it('patches an existing reasoning part without moving content', () => {
    const message = response();
    const updated = applyReasoningLabel(message, baseEvent);

    expect(updated).not.toBe(message);
    expect(updated.content).toHaveLength(1);
    expect(updated.content?.[0]).toMatchObject({
      type: ContentTypes.THINK,
      think: 'Visible reasoning',
      reasoning_label: 'Tracing resume ownership',
      reasoning_label_step_id: 'reasoning-1',
      reasoning_label_revision: 1,
      reasoning_label_status: 'streaming',
    });
  });

  it('rejects stale and same-revision conflicting updates', () => {
    const current = applyReasoningLabel(response(), { ...baseEvent, revision: 2 });
    expect(
      applyReasoningLabel(current, {
        ...baseEvent,
        revision: 1,
        label: 'Stale label',
      }),
    ).toBe(current);
    expect(
      applyReasoningLabel(current, {
        ...baseEvent,
        revision: 2,
        label: 'Conflicting label',
      }),
    ).toBe(current);
  });

  it('allows an equal-revision terminal status upgrade', () => {
    const current = applyReasoningLabel(response(), baseEvent);
    const completed = applyReasoningLabel(current, { ...baseEvent, status: 'complete' });
    expect(completed.content?.[0]).toMatchObject({
      reasoning_label_revision: 1,
      reasoning_label_status: 'complete',
    });
    expect(applyReasoningLabel(completed, baseEvent)).toBe(completed);
  });

  it('clears a stale snapshot label when its THINK slot belongs to a new step', () => {
    const oldStep = applyReasoningLabel(response(), {
      ...baseEvent,
      stepId: 'old-step',
      revision: 3,
      label: 'Inspecting the old direction',
      status: 'complete',
    });
    const updated = applyReasoningLabel(oldStep, {
      index: 0,
      stepId: 'new-step',
      reset: true,
      previousStepId: 'old-step',
      attempts: 4,
      responseMessageId: 'response-1',
    });

    expect(updated.content?.[0]).toMatchObject({
      type: ContentTypes.THINK,
      think: 'Visible reasoning',
      reasoning_label_step_id: 'new-step',
      reasoning_label_attempts: 4,
    });
    expect(updated.content?.[0]).not.toHaveProperty('reasoning_label');
    expect(updated.content?.[0]).not.toHaveProperty('reasoning_label_revision');
    expect(updated.content?.[0]).not.toHaveProperty('reasoning_label_status');
    expect(
      applyReasoningLabel(updated, {
        index: 0,
        stepId: 'new-step',
        reset: true,
        previousStepId: 'old-step',
      }),
    ).toBe(updated);
  });

  it('ignores a reset after the new step already received a label', () => {
    const newer = applyReasoningLabel(response(), {
      ...baseEvent,
      stepId: 'new-step',
      revision: 2,
      label: 'Inspecting the new direction',
    });

    expect(
      applyReasoningLabel(newer, {
        index: 0,
        stepId: 'new-step',
        reset: true,
        previousStepId: 'old-step',
        attempts: 2,
      }),
    ).toBe(newer);
  });

  it('applies an ownership reset before a replacement-step label', () => {
    const oldStep = applyReasoningLabel(response(), {
      ...baseEvent,
      stepId: 'old-step',
      label: 'Inspecting the old direction',
    });
    const reset = applyReasoningLabel(oldStep, {
      index: 0,
      stepId: 'new-step',
      reset: true,
      previousStepId: 'old-step',
      attempts: 2,
    });
    const updated = applyReasoningLabel(reset, {
      ...baseEvent,
      stepId: 'new-step',
      revision: 2,
      label: 'Inspecting the new direction',
    });

    expect(updated.content?.[0]).toMatchObject({
      reasoning_label: 'Inspecting the new direction',
      reasoning_label_step_id: 'new-step',
      reasoning_label_revision: 2,
      reasoning_label_attempts: 2,
    });
  });

  it('does not overwrite another reasoning step at the raw index', () => {
    const oldStep = applyReasoningLabel(response(), {
      ...baseEvent,
      stepId: 'old-step',
      revision: 3,
      label: 'Inspecting the old direction',
      status: 'complete',
    });
    expect(
      applyReasoningLabel(oldStep, {
        ...baseEvent,
        stepId: 'new-step',
        revision: 1,
        label: 'Tracing the regenerated direction',
      }),
    ).toBe(oldStep);
  });

  it('correlates by step id when an active resume snapshot compacted sparse slots', () => {
    const compacted = response();
    compacted.content = [
      {
        type: ContentTypes.THINK,
        think: 'Visible reasoning',
        reasoning_label_step_id: 'reasoning-1',
      },
    ];

    const updated = applyReasoningLabel(compacted, { ...baseEvent, index: 2 });

    expect(updated.content?.[0]).toMatchObject({
      reasoning_label: 'Tracing resume ownership',
      reasoning_label_step_id: 'reasoning-1',
      reasoning_label_revision: 1,
    });
  });

  it('targets the exact assistant response id', () => {
    const messages = [
      { ...response(), messageId: 'other-response' },
      response(),
      { ...response(), messageId: 'user-2', isCreatedByUser: true },
    ];
    expect(findReasoningLabelMessageIndex(messages, baseEvent)).toBe(1);
    expect(
      findReasoningLabelMessageIndex(messages, {
        ...baseEvent,
        responseMessageId: 'missing-response',
      }),
    ).toBe(-1);
  });
});
