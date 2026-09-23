import { Link } from 'react-router-dom';
import { LayoutGrid } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize, useShowMarketplace } from '~/hooks';
import { cn } from '~/utils';

interface AgentMarketplaceButtonProps {
  /** Which way the tooltip opens: the desktop rail is a left edge, the mobile
   *  drawer header is a top edge. Ignored by the `row` layout, which has no
   *  tooltip to place. */
  side?: 'right' | 'bottom';
  /** Mobile dismisses the drawer on navigation; the desktop rail stays put. */
  onNavigate?: () => void;
  /**
   * `icon` is the rail's square, labelled by a tooltip. `row` is a full-width
   * entry carrying its own label, for the mobile drawer: an icon in a header
   * strip is the easiest thing there to miss, and the list it now heads is
   * where someone already looks for somewhere to go.
   */
  layout?: 'icon' | 'row';
}

/** Agent Marketplace entry in the sidebar. Self-gated on marketplace
 *  permissions, so a deployment without access is left with no gap. */
export default function AgentMarketplaceButton({
  side = 'right',
  onNavigate,
  layout = 'icon',
}: AgentMarketplaceButtonProps) {
  const localize = useLocalize();
  const showAgentMarketplace = useShowMarketplace();

  if (!showAgentMarketplace) {
    return null;
  }

  const isRow = layout === 'row';

  /** Composed through the shared button so the focus ring, hover fill and theme
   *  timing come from the primitive rather than being restated: a hand-rolled
   *  version of this had no focus ring at all. `asChild` keeps it a router Link,
   *  so modifier- and middle-clicks still open the marketplace in a new tab, and
   *  those stay on the current page and so must not dismiss. */
  const button = (
    <Button
      asChild
      variant="ghost"
      size={isRow ? 'default' : 'icon'}
      className={cn('shrink-0', isRow ? 'h-10 w-full justify-start px-1.5' : 'h-9 w-9')}
    >
      <Link
        to="/agents"
        data-testid="nav-agents-marketplace-button"
        aria-label={isRow ? undefined : localize('com_agents_marketplace')}
        onClick={(event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
          }
          onNavigate?.();
        }}
      >
        <LayoutGrid className="text-text-primary h-5 w-5 shrink-0" aria-hidden="true" />
        {isRow && (
          <span className="text-text-primary min-w-0 truncate text-sm font-medium">
            {localize('com_agents_marketplace')}
          </span>
        )}
      </Link>
    </Button>
  );

  if (isRow) {
    return button;
  }

  return (
    <TooltipAnchor side={side} description={localize('com_agents_marketplace')} render={button} />
  );
}
