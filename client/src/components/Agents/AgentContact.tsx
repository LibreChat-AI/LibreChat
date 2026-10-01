import { UserRound } from 'lucide-react';
import type t from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type AgentContactProps = {
  agent?: Pick<t.Agent, 'support_contact' | 'owner_contact'> | null;
  className?: string;
  compact?: boolean;
};

/**
 * Public contact for an agent: an explicit support contact wins over the owner,
 * and a missing name falls back to the address. Exported so a caller can tell
 * whether a contact row exists at all before wiring it into a layout animation.
 */
export const resolveAgentContact = (
  agent?: Pick<t.Agent, 'support_contact' | 'owner_contact'> | null,
): { name: string; email: string } | null => {
  const supportName = agent?.support_contact?.name?.trim() ?? '';
  const supportEmail = agent?.support_contact?.email?.trim() ?? '';
  const ownerName = agent?.owner_contact?.name?.trim() ?? '';
  if (supportName || supportEmail) {
    return { name: supportName, email: supportEmail };
  }
  if (ownerName) {
    return { name: ownerName, email: '' };
  }
  return null;
};

export default function AgentContact({
  agent,
  className = '',
  compact = false,
}: AgentContactProps) {
  const localize = useLocalize();
  const contact = resolveAgentContact(agent);
  if (compact && !contact) {
    return null;
  }

  const label = contact?.name || contact?.email || localize('com_agents_no_contact_available');

  return (
    <div
      className={cn(
        'text-text-secondary flex min-w-0 items-center gap-1',
        compact && 'gap-2 text-xs',
        className,
      )}
    >
      {compact ? (
        <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <span className="shrink-0">{localize('com_agents_contact')}:</span>
      )}
      <span className="min-w-0 truncate">
        {contact?.email ? (
          <a
            href={`mailto:${contact.email}`}
            className="text-text-primary focus-visible:ring-text-primary inline-block max-w-full truncate rounded-sm py-1 hover:underline focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset"
          >
            {label}
          </a>
        ) : (
          label
        )}
      </span>
    </div>
  );
}
