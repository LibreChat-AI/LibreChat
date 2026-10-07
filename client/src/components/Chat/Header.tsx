import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '@librechat/client';
import { useOutletContext } from 'react-router-dom';
import { getConfigDefaults, PermissionTypes, Permissions } from 'librechat-data-provider';
import type { ContextType } from '~/common';
import { PresetsMenu } from './Menus';
// HeaderNewChat and the standalone OpenSidebar toggle are intentionally not
// used below — the sidebar's own controls (New Chat button and, when
// collapsed, its own toggle icon in the icon rail) are kept instead, so this
// header doesn't need a duplicate.
// import { HeaderNewChat, OpenSidebar } from './Menus';
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import BookmarkMenu from './Menus/BookmarkMenu';
import { TemporaryChat } from './TemporaryChat';
import AddMultiConvo from './AddMultiConvo';
import { useAuthContext, useHasAccess } from '~/hooks';
import { cn } from '~/utils';
import LocationMenu from './LocationMenu';

const defaultInterface = getConfigDefaults().interface;

export default function Header() {
  const { data: startupConfig } = useGetStartupConfig();
  const { navVisible } = useOutletContext<ContextType>();
  const { user } = useAuthContext();

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });

  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  const [bannerPortal, setBannerPortal] = useState<Element | null>(null);

  useEffect(() => {
    const node = document.getElementById('banner-left-portal');
    if (node) setBannerPortal(node);
    const observer = new MutationObserver(() => {
      const p = document.getElementById('banner-left-portal');
      if (p !== bannerPortal) setBannerPortal(p);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [bannerPortal]);

  // ModelSelector moved into the chat input toolbar (left of the microphone button)
  const modelSelectorNodes = (
    <div className="flex items-center gap-1.5 sm:gap-2">
      {/* {interfaceConfig.presets === true && interfaceConfig.modelSelect && <PresetsMenu />}
      {hasAccessToMultiConvo === true && <AddMultiConvo />} */}
      <LocationMenu isSmallScreen={isSmallScreen}/>
    </div>
  );

  // No fill or rule of its own: the bar floats over the message list and its controls carry
  // their own backgrounds. It used to paint a downward gradient, which read as a drop shadow.
  return (
    <div className="absolute top-0 z-10 flex h-14 w-full items-center justify-between bg-transparent px-1.5 py-2 font-semibold text-text-primary sm:p-2">
      <div className="hide-scrollbar flex w-full items-center justify-between gap-1.5 overflow-x-auto sm:gap-2">
        <div className="mx-1 flex w-full flex-1 items-center">
          {!isSmallScreen && bannerPortal ? createPortal(modelSelectorNodes, bannerPortal) : null}

          {!(navVisible && isSmallScreen) && (
            <div
              className={cn(
                'flex w-full flex-1 items-center gap-1.5 sm:gap-2',
                !isSmallScreen ? 'transition-all duration-200 ease-in-out' : '',
                !navVisible && !isSmallScreen ? 'pl-2' : '',
              )}
            >
              {/* {!bannerPortal && modelSelectorNodes} */}
              {hasAccessToBookmarks === true && <BookmarkMenu />}
              {isSmallScreen && (
                <div className="flex w-full flex-1 items-center justify-end gap-1.5">
                  {modelSelectorNodes}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Temporary chat + share/export menu, portaled to body so fixed positioning
         works even when parent panels apply CSS transforms */}
      {createPortal(
        <div className="fixed right-3 top-3 z-[100] flex items-center gap-1.5">
          <TemporaryChat />
          <ExportAndShareMenu isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false} />
        </div>,
        document.body,
      )}
    </div>
  );
}
