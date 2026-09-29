import React, { forwardRef } from 'react';
import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import PrincipalAvatar from '~/components/Sharing/PrincipalAvatar';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface PeoplePickerSearchItemProps extends React.HTMLAttributes<HTMLDivElement> {
  principal: TPrincipal;
}

const PeoplePickerSearchItem = forwardRef<HTMLDivElement, PeoplePickerSearchItemProps>(
  function PeoplePickerSearchItem(
    { principal, className, style, onClick, ...props },
    forwardedRef,
  ) {
    const localize = useLocalize();
    const { name, email, type } = principal;

    const displayName = name || localize('com_ui_unknown');
    const subtitle = email || `${type} (${principal.source || 'local'})`;

    /** Semantic series roles rather than palette hues: a raw utility does not
     *  move when the theme does, and these labels render at 12px, so they answer
     *  to the text floor on whichever canvas the viewer picked. */
    const getBadgeConfig = () => {
      switch (type) {
        case PrincipalType.USER:
          return {
            className: 'bg-series-1/10 text-series-1',
            label: localize('com_ui_user'),
          };
        case PrincipalType.GROUP:
          return {
            className: 'bg-series-7/10 text-series-7',
            label: localize('com_ui_group'),
          };
        case PrincipalType.ROLE:
          return {
            className: 'bg-series-6/10 text-series-6',
            label: localize('com_ui_role'),
          };
        default:
          return {
            className: 'bg-surface-tertiary text-text-secondary',
            label: type,
          };
      }
    };

    const badgeConfig = getBadgeConfig();

    return (
      <div
        {...props}
        ref={forwardedRef}
        className={cn('flex items-center gap-3 p-2', className)}
        style={style}
        onClick={(event) => {
          onClick?.(event);
        }}
      >
        <PrincipalAvatar principal={principal} size="md" />

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{displayName}</div>
          <div className="truncate text-xs text-text-secondary">{subtitle}</div>
        </div>

        <div className="flex-shrink-0">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium',
              badgeConfig.className,
            )}
          >
            {badgeConfig.label}
          </span>
        </div>
      </div>
    );
  },
);

export default PeoplePickerSearchItem;
