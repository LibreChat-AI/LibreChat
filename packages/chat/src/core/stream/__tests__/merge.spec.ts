import type { TMessage, EventSubmission } from 'librechat-data-provider';
import type { StepContext } from '../state';
import { ensureUserMessagePresent, mergeResponseMessage } from '../merge';

const msg = (fields: Partial<TMessage>): TMessage => ({ text: '', ...fields }) as TMessage;

const makeCtx = (submission: Partial<EventSubmission>, list: TMessage[] = []): StepContext => ({
  submission: submission as EventSubmission,
  getMessages: () => list,
  setMessages: () => undefined,
});

describe('stream merge', () => {
  const userMessage = msg({ messageId: 'u1', isCreatedByUser: true });

  it('inserts the user message before the first child of it', () => {
    const child = msg({ messageId: 'old', parentMessageId: 'u1' });
    const submission = { userMessage } as EventSubmission;
    const result = ensureUserMessagePresent(submission, [child], 'r1');
    expect(result.map((m) => m.messageId)).toEqual(['u1', 'old']);
  });

  it('leaves the list alone for a regenerate', () => {
    const list = [msg({ messageId: 'a' })];
    const submission = { userMessage, isRegenerate: true } as EventSubmission;
    expect(ensureUserMessagePresent(submission, list, 'r1')).toBe(list);
  });

  it('replaces the placeholder response with the updated response', () => {
    const placeholder = msg({ messageId: 'p', parentMessageId: 'u1' });
    const ctx = makeCtx({ userMessage, initialResponse: placeholder, messages: [] });
    const updated = msg({ messageId: 'r1', parentMessageId: 'u1' });
    const result = mergeResponseMessage(ctx, [userMessage, placeholder], updated, 'r1');
    expect(result.map((m) => m.messageId)).toEqual(['u1', 'r1']);
  });

  it('drops the regenerated response and appends the new one', () => {
    const old = msg({ messageId: 'r1' });
    const ctx = makeCtx({ userMessage, isRegenerate: true });
    const updated = msg({ messageId: 'r1', text: 'new' });
    const result = mergeResponseMessage(ctx, [userMessage, old], updated, 'r1');
    expect(result.find((m) => m.messageId === 'r1')?.text).toBe('new');
    expect(result).toHaveLength(2);
  });
});
