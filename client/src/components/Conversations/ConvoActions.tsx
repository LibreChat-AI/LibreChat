import { memo, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { Button, useMediaQuery } from '@librechat/client';
import type { MouseEvent } from 'react';
import { ConvoOptions } from './ConvoOptions';
import { useLocalize } from '~/hooks';

export type ConvoActionsProps = {
  conversationId: string | null;
  chatProjectId?: string | null;
  title: string | null;
  isPinned?: boolean;
  isArchived?: boolean;
  isActiveConvo: boolean;
  isShiftHeld?: boolean;
  isPopoverActive: boolean;
  /** True once the pointer or focus has reached the row. */
  hasInteracted: boolean;
  retainView: () => void;
  renameHandler: (e: MouseEvent) => void;
  onOpenChange: (open: boolean) => void;
};

/**
 * Owns the row's overflow control: which control is rendered, when it is
 * visible, and where focus lives across the swap between them.
 *
 * Two controls can represent this menu — `ConvoOptions`, which carries six
 * mutations and its own menu store, and a cheap placeholder that stands in
 * until the menu is wanted. Mounting the real one for every overscanned row is
 * wasteful, but the two must agree about identity, visibility, focus and
 * lifecycle, and splitting those decisions across the row is what made them
 * disagree. They are settled together here:
 *
 * - **Which.** A pointer device reveals the menu on hover, so hovering is
 *   enough to mount the real one. Touch has no hover, so the placeholder is
 *   what makes the menu discoverable at all.
 * - **When it sticks.** Once a row's menu has been opened, the real one stays.
 *   Swapping back would destroy Ariakit's button — its own final-focus target —
 *   and strand focus on the document, since the placeholder is a different
 *   node. Rows never opened still mount nothing, which is the point.
 * - **Visibility.** `ConvoOptions` reveals its trigger on hover or focus; on
 *   touch it is told to stay visible, or an interacted row keeps only an
 *   invisible hit target.
 * - **Activation.** A plain click. The browser withholds it until a press
 *   resolves as a tap rather than a scroll, and synthesises it for keyboard and
 *   assistive-technology activation — so no pointer-level handling is needed,
 *   and none should be added: claiming the press earlier is what previously
 *   opened menus mid-scroll.
 */
function ConvoActions({
  hasInteracted,
  isActiveConvo,
  isPopoverActive,
  onOpenChange,
  ...options
}: ConvoActionsProps) {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [hasOpenedMenu, setHasOpenedMenu] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setHasOpenedMenu(true);
    }
    onOpenChange(open);
  };

  const showMenu = isSmallScreen
    ? isPopoverActive || isActiveConvo || hasOpenedMenu
    : hasInteracted || isActiveConvo;

  if (showMenu) {
    return (
      <ConvoOptions
        {...options}
        isActiveConvo={isActiveConvo}
        isPopoverActive={isPopoverActive}
        setIsPopoverActive={handleOpenChange}
      />
    );
  }

  if (!isSmallScreen) {
    return null;
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={localize('com_nav_convo_menu_options')}
      data-testid="convo-options-trigger"
      className="size-9 text-text-secondary"
      onClick={(event) => {
        event.stopPropagation();
        handleOpenChange(true);
      }}
    >
      <Ellipsis className="icon-md" aria-hidden="true" />
    </Button>
  );
}

export default memo(ConvoActions);
