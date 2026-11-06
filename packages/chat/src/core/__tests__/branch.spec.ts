import { ReasoningEffort } from 'librechat-data-provider';
import type { TMessage, TReasoningOverride } from 'librechat-data-provider';
import { getBranchReasoning } from '../branch';

const msg = (fields: Partial<TMessage> & Pick<TMessage, 'messageId'>): TMessage => ({
  conversationId: 'c1',
  parentMessageId: null,
  text: '',
  isCreatedByUser: false,
  ...fields,
});

describe('getBranchReasoning', () => {
  const high: TReasoningOverride = { key: 'reasoning_effort', value: ReasoningEffort.high };
  const low: TReasoningOverride = { key: 'reasoning_effort', value: ReasoningEffort.low };

  it('takes the override of the nearest user message at or above the start', () => {
    const messages = [
      msg({ messageId: 'u1', isCreatedByUser: true, reasoningOverride: low }),
      msg({ messageId: 'a1', parentMessageId: 'u1' }),
      msg({
        messageId: 'u2',
        parentMessageId: 'a1',
        isCreatedByUser: true,
        reasoningOverride: high,
      }),
      msg({ messageId: 'a2', parentMessageId: 'u2' }),
    ];

    expect(getBranchReasoning(messages, 'a2')).toEqual(high);
    expect(getBranchReasoning(messages, 'u2')).toEqual(high);
    expect(getBranchReasoning(messages, 'a1')).toEqual(low);
  });

  it('skips user messages without an override and ignores responses that carry one', () => {
    const messages = [
      msg({ messageId: 'u1', isCreatedByUser: true, reasoningOverride: low }),
      msg({ messageId: 'a1', parentMessageId: 'u1', reasoningOverride: high }),
      msg({ messageId: 'u2', parentMessageId: 'a1', isCreatedByUser: true }),
    ];

    expect(getBranchReasoning(messages, 'u2')).toEqual(low);
  });

  it('follows only the branch it starts on', () => {
    const messages = [
      msg({ messageId: 'u1', isCreatedByUser: true }),
      msg({ messageId: 'a1', parentMessageId: 'u1' }),
      msg({
        messageId: 'u2',
        parentMessageId: 'a1',
        isCreatedByUser: true,
        reasoningOverride: high,
      }),
      msg({ messageId: 'u3', parentMessageId: 'a1', isCreatedByUser: true }),
    ];

    expect(getBranchReasoning(messages, 'u3')).toBeUndefined();
  });

  it('returns nothing for an unknown start and stops on a parent cycle', () => {
    const messages = [
      msg({ messageId: 'x', parentMessageId: 'y' }),
      msg({ messageId: 'y', parentMessageId: 'x' }),
    ];

    expect(getBranchReasoning(messages, 'missing')).toBeUndefined();
    expect(getBranchReasoning(messages, 'x')).toBeUndefined();
  });
});
