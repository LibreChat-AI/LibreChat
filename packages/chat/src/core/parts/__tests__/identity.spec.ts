import { Constants } from 'librechat-data-provider';
import type { RenderIdentityInput } from '../identity';
import { advanceRenderIdentity } from '../identity';

const base: RenderIdentityInput = {
  messageId: 'msg_1',
  conversationId: 'convo_1',
  ownerId: undefined,
  isLatestMessage: true,
  isSubmitting: false,
  isCreatedByUser: false,
};

describe('advanceRenderIdentity', () => {
  it('starts at scope 0 and keeps the same identity while nothing changes', () => {
    const first = advanceRenderIdentity(null, base);
    expect(first).toMatchObject({ messageId: 'msg_1', scope: 0 });
    expect(advanceRenderIdentity(first, base)).toBe(first);
  });

  it('moves to the next scope when another message takes the instance', () => {
    const first = advanceRenderIdentity(null, base);
    const next = advanceRenderIdentity(first, { ...base, messageId: 'msg_2' });
    expect(next).not.toBe(first);
    expect(next).toMatchObject({ messageId: 'msg_2', scope: 1 });
  });

  it('follows a streaming response from its placeholder to the saved message', () => {
    const placeholder = advanceRenderIdentity(null, {
      ...base,
      messageId: 'user_1_',
      conversationId: Constants.NEW_CONVO as string,
      ownerId: 'user_1',
      isSubmitting: true,
    });
    const created = advanceRenderIdentity(placeholder, {
      ...base,
      messageId: 'response_1_',
      conversationId: 'convo_1',
      ownerId: 'user_1',
      isSubmitting: true,
    });
    expect(created).toBe(placeholder);
    const saved = advanceRenderIdentity(created, { ...base, messageId: 'response_1' });
    expect(saved).toBe(placeholder);
    expect(saved).toMatchObject({
      messageId: 'response_1',
      conversationId: 'convo_1',
      ownerId: 'user_1',
      isSubmitting: false,
      scope: 0,
    });
  });

  it('does not follow an owner id into another conversation, a user turn, or an older message', () => {
    const streaming = (): ReturnType<typeof advanceRenderIdentity> =>
      advanceRenderIdentity(null, {
        ...base,
        messageId: 'user_1_',
        ownerId: 'user_1',
        isSubmitting: true,
      });
    const next = { ...base, messageId: 'response_1_', ownerId: 'user_1', isSubmitting: true };

    expect(advanceRenderIdentity(streaming(), next).scope).toBe(0);
    expect(advanceRenderIdentity(streaming(), { ...next, conversationId: 'convo_2' }).scope).toBe(
      1,
    );
    expect(advanceRenderIdentity(streaming(), { ...next, isCreatedByUser: true }).scope).toBe(1);
    expect(advanceRenderIdentity(streaming(), { ...next, isLatestMessage: false }).scope).toBe(1);
    expect(advanceRenderIdentity(streaming(), { ...next, ownerId: 'user_2' }).scope).toBe(1);
  });

  it('treats a settled message that starts generating again as another response', () => {
    const settled = advanceRenderIdentity(null, base);
    expect(advanceRenderIdentity(settled, { ...base, isSubmitting: true }).scope).toBe(1);
  });

  it('does not take a still-optimistic id for the saved message', () => {
    const streaming = advanceRenderIdentity(null, {
      ...base,
      messageId: 'response_1_',
      ownerId: 'user_1',
      isSubmitting: true,
    });
    expect(advanceRenderIdentity(streaming, { ...base, messageId: 'response_2_' }).scope).toBe(1);
  });
});
