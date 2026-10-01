import React, { forwardRef } from 'react';
import { SeriesLabel } from '@librechat/client';
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

    /** Semantic series slots rather than palette hues, so the dot moves with the theme. */
    const getBadgeConfig = () => {
      switch (type) {
        case PrincipalType.USER:
          return {
            hue: 1 as const,
            label: localize('com_ui_user'),
          };
        case PrincipalType.GROUP:
          return {
            hue: 7 as const,
            label: localize('com_ui_group'),
          };
        case PrincipalType.ROLE:
          return {
            hue: 6 as const,
            label: localize('com_ui_role'),
          };
        default:
          return {
            hue: undefined,
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
          <div className="text-text-primary truncate text-sm font-medium">{displayName}</div>
          <div className="text-text-secondary truncate text-xs">{subtitle}</div>
        </div>

        <div className="shrink-0">
          <SeriesLabel hue={badgeConfig.hue} className="text-xs font-medium">
            {badgeConfig.label}
          </SeriesLabel>
        </div>
      </div>
    );
  },
);

export default PeoplePickerSearchItem;
