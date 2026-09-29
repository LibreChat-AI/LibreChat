import { Link } from 'react-router-dom';
import { LayoutGrid } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize, useShowMarketplace } from '~/hooks';

interface AgentMarketplaceButtonProps {
  /** Which way the tooltip opens: the desktop rail is a left edge, the mobile
   *  drawer header is a top edge. */
  side?: 'right' | 'bottom';
  /** Mobile dismisses the drawer on navigation; the desktop rail stays put. */
  onNavigate?: () => void;
}

/** Agent Marketplace entry in the sidebar. Self-gated on marketplace
 *  permissions, so a deployment without access is left with no gap. */
export default function AgentMarketplaceButton({
  side = 'right',
  onNavigate,
}: AgentMarketplaceButtonProps) {
  const localize = useLocalize();
  const showAgentMarketplace = useShowMarketplace();

  if (!showAgentMarketplace) {
    return null;
  }

  return (
    <TooltipAnchor
      side={side}
      description={localize('com_agents_marketplace')}
      render={
        /** Composed through the shared button so the focus ring, hover fill and
         *  theme timing come from the primitive rather than being restated: a
         *  hand-rolled version of this had no focus ring at all. `asChild`
         *  keeps it a router Link, so modifier- and middle-clicks still open
         *  the marketplace in a new tab, and those stay on the current page and
         *  so must not dismiss. */
        <Button asChild variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0">
          <Link
            to="/agents"
            data-testid="nav-agents-marketplace-button"
            aria-label={localize('com_agents_marketplace')}
            onClick={(event) => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
              }
              onNavigate?.();
            }}
          >
            <LayoutGrid className="h-5 w-5 text-text-primary" aria-hidden="true" />
          </Link>
        </Button>
      }
    />
  );
}
