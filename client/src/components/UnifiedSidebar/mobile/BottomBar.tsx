import { memo } from 'react';
import { useRecoilValue } from 'recoil';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import SearchBar from '~/components/Nav/SearchBar';
import store from '~/store';

/**
 * Search, in reach of a thumb. A flex footer rather than an overlay, so the
 * virtualized list shrinks around it and can never be occluded.
 *
 * New chat used to sit here too and is now in the header strip: repeated under
 * every panel it was a second, larger copy of a destination that has nothing to
 * do with prompts, memories or MCP settings.
 */
function BottomBar({ links }: { links: NavLink[] }) {
  const search = useRecoilValue(store.search);
  const { active } = useActivePanel();

  /** Searching messages only means anything from the conversation list. */
  const showSearch = search.enabled === true && resolveActivePanel(active, links) === DEFAULT_PANEL;

  if (!showSearch) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 items-center px-3 pt-2"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="min-w-0 flex-1">
        <SearchBar isSmallScreen={true} />
      </div>
    </div>
  );
}

export default memo(BottomBar);
