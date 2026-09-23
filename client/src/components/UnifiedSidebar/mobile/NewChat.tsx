import { memo, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { SquarePen } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useActivePanel, DEFAULT_PANEL } from '~/Providers';
import { useShortcutAriaKey } from '~/hooks/useKeyboardShortcuts';
import useNewChat from '~/hooks/Chat/useNewChat';
import { useLocalize } from '~/hooks';
import store from '~/store';

/**
 * New chat, in the drawer's header strip beside the panel switcher.
 *
 * It sat in the footer, which put it under the thumb but also under every panel,
 * repeating a destination that has nothing to do with prompts or memories. The
 * header is where the drawer keeps the controls that mean the same thing
 * whichever panel is showing.
 */
function NewChat({ onNewChat }: { onNewChat: (afterSlide?: () => void) => void }) {
  const localize = useLocalize();
  const switchToHistory = useRecoilValue(store.newChatSwitchToHistory);
  const { setActive } = useActivePanel();
  const { startNewChat } = useNewChat();

  /**
   * Close first, reset second, the inverse of `useNewChat`'s own click
   * handler: `startNewChat` clears the message cache and resets the
   * conversation, and run synchronously that commit stalls the drawer
   * slide's first frame on large conversations. The reset (and the panel
   * switch-back) ride the close's `afterSlide` instead, landing mid-slide.
   * The modified-click guard mirrors `useNewChat.handleNewChatClick` so a
   * ctrl/middle click still opens `/c/new` in a new tab.
   */
  const handleNewChatClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      onNewChat(() => {
        if (switchToHistory) {
          setActive(DEFAULT_PANEL);
        }
        startNewChat();
      });
    },
    [onNewChat, switchToHistory, setActive, startNewChat],
  );

  /** The shortcut fires globally; assistive tech needs it discoverable here too. */
  const newChatAriaKey = useShortcutAriaKey('newChat');

  return (
    <TooltipAnchor
      side="bottom"
      description={localize('com_ui_new_chat')}
      render={
        <Button asChild variant="ghost" size="icon" className="h-9 w-9 shrink-0">
          <a
            href="/c/new"
            data-testid="nav-new-chat-fab"
            aria-label={localize('com_ui_new_chat')}
            aria-keyshortcuts={newChatAriaKey}
            onClick={handleNewChatClick}
          >
            <SquarePen className="text-text-primary size-5" aria-hidden="true" />
          </a>
        </Button>
      }
    />
  );
}

export default memo(NewChat);
