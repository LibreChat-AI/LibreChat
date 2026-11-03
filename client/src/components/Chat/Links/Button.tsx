import { Link2 } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** Header control that toggles the session links panel beside the chat.
 * `outline-toggle` carries its own pressed treatment for `aria-pressed`. */
export default function LinksButton({ isOpen, onClick }: { isOpen: boolean; onClick: () => void }) {
  const localize = useLocalize();
  const label = localize('com_links_header_button');

  return (
    <TooltipAnchor
      description={label}
      render={
        <Button
          size="icon"
          variant="outline-toggle"
          aria-label={label}
          aria-pressed={isOpen}
          onClick={onClick}
          data-testid="header-links-button"
        >
          <Link2 className="icon-md" aria-hidden="true" />
        </Button>
      }
    />
  );
}
