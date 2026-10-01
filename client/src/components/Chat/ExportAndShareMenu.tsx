import { useState, useId } from 'react';
import { Share2 } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { DropdownPopup, TooltipAnchor, useMediaQuery } from '@librechat/client';
import useExportShare from '~/hooks/Chat/useExportShare';
import { useLocalize } from '~/hooks';

export default function ExportAndShareMenu({
  isSharedButtonEnabled,
}: {
  isSharedButtonEnabled: boolean;
}) {
  const localize = useLocalize();
  const menuId = useId();
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { show, items, hasSharedLink, dialogs } = useExportShare({ isSharedButtonEnabled });

  if (!show) {
    return null;
  }

  const description = localize(
    hasSharedLink ? 'com_ui_export_share_link_active' : 'com_endpoint_export_share',
  );

  return (
    <>
      <DropdownPopup
        portal={true}
        menuId={menuId}
        focusLoop={true}
        unmountOnHide={true}
        isOpen={isPopoverActive}
        setIsOpen={setIsPopoverActive}
        trigger={
          <TooltipAnchor
            description={description}
            render={
              <Ariakit.MenuButton
                id="export-menu-button"
                aria-label={description}
                className="border-border-light bg-presentation text-text-primary hover:bg-surface-tertiary aria-expanded:bg-surface-tertiary relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl border transition-all ease-in-out disabled:pointer-events-none disabled:opacity-50"
              >
                <Share2
                  className="icon-md text-text-primary"
                  aria-hidden="true"
                  focusable="false"
                />
                {hasSharedLink && (
                  <span
                    className="bg-status-info ring-presentation absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2"
                    data-testid="header-shared-link-indicator"
                    aria-hidden="true"
                  />
                )}
              </Ariakit.MenuButton>
            }
          />
        }
        items={items}
        className={isSmallScreen ? '' : 'absolute top-0 right-0 mt-2'}
      />
      {dialogs}
    </>
  );
}
