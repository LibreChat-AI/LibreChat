import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide';
import { cn, MorphIcon, useLocalize, TooltipAnchor } from '@librechat/client';
import type { NamedExoticComponent } from 'react';

type CollapseChatProps = {
  isScrollable: boolean;
  isCollapsed: boolean;
  setIsCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
};

const CollapseChat = ({
  isScrollable,
  isCollapsed,
  setIsCollapsed,
}: CollapseChatProps): React.JSX.Element | null => {
  const localize = useLocalize();
  if (!isScrollable) {
    return null;
  }

  const description = isCollapsed
    ? localize('com_ui_expand_chat')
    : localize('com_ui_collapse_chat');

  return (
    <div className="relative ms-auto items-end justify-end">
      <TooltipAnchor
        description={description}
        render={
          <button
            aria-label={description}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsCollapsed((prev) => !prev);
            }}
            className={cn(
              // 'absolute right-1.5 top-1.5',
              'z-10 size-5 rounded-full transition-colors',
              'focus-visible:ring-text-primary/50 focus-visible:ring-2 focus-visible:outline-hidden',
            )}
          >
            <MorphIcon icon={isCollapsed ? ChevronUp : ChevronDown} className="h-full w-full" />
          </button>
        }
      />
    </div>
  );
};

const MemoCollapseChat: NamedExoticComponent<CollapseChatProps> = React.memo(CollapseChat);

export default MemoCollapseChat;
