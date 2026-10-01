import type { TConversation } from 'librechat-data-provider';
import { areConversationRenderPropsEqual } from '../utils';

const convo = { conversationId: 'c1', title: 'Chat' } as TConversation;

describe('areConversationRenderPropsEqual', () => {
  it('treats identical props as equal', () => {
    expect(areConversationRenderPropsEqual({ conversation: convo }, { conversation: convo })).toBe(
      true,
    );
  });

  /* The shortcut appears only once the pinned order has loaded, so it changes
   * without the conversation doing so. Ignoring it here would memo the row and
   * leave its focusable element permanently unable to announce the shortcut. */
  it('notices the reorder shortcut appearing on an otherwise unchanged row', () => {
    expect(
      areConversationRenderPropsEqual(
        { conversation: convo },
        { conversation: convo, keyShortcuts: 'Alt+ArrowUp Alt+ArrowDown' },
      ),
    ).toBe(false);
  });

  it('notices it going away again', () => {
    expect(
      areConversationRenderPropsEqual(
        { conversation: convo, keyShortcuts: 'Alt+ArrowUp Alt+ArrowDown' },
        { conversation: convo },
      ),
    ).toBe(false);
  });
});
