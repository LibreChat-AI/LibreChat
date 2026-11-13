import type { MCPServerOwnerContact, SupportContact } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type MCPServerContactSource = {
  dbId?: string;
  support_contact?: SupportContact;
  owner_contact?: MCPServerOwnerContact;
};

type MCPServerContactProps = {
  server?: MCPServerContactSource | null;
  className?: string;
};

export function shouldDisplayMCPServerContact(server?: MCPServerContactSource | null): boolean {
  return Boolean(
    server?.dbId ||
      server?.support_contact?.name?.trim() ||
      server?.support_contact?.email?.trim() ||
      server?.owner_contact?.name?.trim(),
  );
}

export function useMCPServerContactEnabled(): boolean {
  const { data: startupConfig } = useGetStartupConfig();
  return startupConfig?.interface?.mcpServerContact === true;
}

export default function MCPServerContact({ server, className = '' }: MCPServerContactProps) {
  const localize = useLocalize();
  const isEnabled = useMCPServerContactEnabled();
  const supportName = server?.support_contact?.name?.trim();
  const supportEmail = server?.support_contact?.email?.trim();
  const ownerName = server?.owner_contact?.name?.trim();
  const name = supportName || supportEmail || ownerName;

  if (!isEnabled || !shouldDisplayMCPServerContact(server)) {
    return null;
  }

  return (
    <div className={cn('text-text-secondary flex min-w-0 items-center gap-1', className)}>
      <span className="shrink-0">{localize('com_ui_mcp_contact')}:</span>
      <span className="min-w-0 truncate">
        {supportEmail ? (
          <a href={`mailto:${supportEmail}`} className="text-text-primary hover:underline">
            {name}
          </a>
        ) : (
          name || localize('com_ui_mcp_no_contact_available')
        )}
      </span>
    </div>
  );
}
