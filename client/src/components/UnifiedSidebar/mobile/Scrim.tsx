import { Button } from '@librechat/client';
import type { MouseEvent } from 'react';
import { DRAWER_Z_INDEX, MOBILE_SCRIM_ID, TRANSITION_MS, EASING } from '../constants';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Covers the strip of conversation the drawer leaves visible, and dismisses it
 * when tapped. Rendered as a sibling of the chat pane rather than inside it,
 * because the pane is inert while the drawer is open and would swallow the
 * click.
 *
 * The shared button carries the focus treatment; `variant`/`size` are cleared
 * because a full-bleed surface wants none of the chrome, not a different set
 * of it.
 */
export default function Scrim({
  expanded,
  isSliding,
  prefersReducedMotion,
  onClick,
}: {
  expanded: boolean;
  /** Both surfaces keep travelling outside the committed state, and a tap in
   *  that window would otherwise reach a control on the pane sliding past. */
  isSliding: boolean;
  prefersReducedMotion: boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}) {
  const localize = useLocalize();

  return (
    <Button
      id={MOBILE_SCRIM_ID}
      variant={null}
      size={null}
      aria-label={localize('com_nav_close_sidebar')}
      onClick={onClick}
      tabIndex={expanded ? 0 : -1}
      aria-hidden={!expanded || undefined}
      className={cn(
        'group absolute inset-0 rounded-none',
        !expanded && !isSliding && 'pointer-events-none',
      )}
      style={{
        zIndex: DRAWER_Z_INDEX - 1,
        /** Style rather than a class so a kicked fade (inline opacity written
         *  at animation start) is not interrupted when Recoil commits the
         *  matching value three frames later. */
        opacity: expanded ? 1 : 0,
        transition: prefersReducedMotion ? undefined : `opacity ${TRANSITION_MS}ms ${EASING}`,
      }}
    >
      {/* The dialogs' theme-owned scrim role, painted on its own layer so the
          button itself carries no color of its own. */}
      <span aria-hidden="true" className="bg-scrim absolute inset-0" />
      {/* The focus indicator, on a layer above the fill: the button's own ring
          paints with its background, under the fill. Inset, because the shell
          is overflow-hidden and would clip a ring drawn outside the box. Two
          tones, because the fill is mid-gray in a light palette and black in a
          dark one: the surface band carries it in light, the ring in dark. */}
      <span
        aria-hidden="true"
        className="group-focus-visible:ring-focus-control group-focus-visible:ring-offset-surface-primary absolute inset-0 group-focus-visible:ring-2 group-focus-visible:ring-offset-2 group-focus-visible:ring-inset"
      />
    </Button>
  );
}
