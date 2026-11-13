import { createContext, useContext } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn, useLocalize } from '@librechat/client';

export const ToolAuthWarningContext: React.Context<boolean> = createContext(false);

export function ToolAuthWarning({ className }: { className?: string }): React.ReactElement | null {
  const localize = useLocalize();
  const suppressed = useContext(ToolAuthWarningContext);

  if (suppressed) {
    return null;
  }

  return (
    <p className={cn('text-text-warning flex items-center text-xs', className)}>
      <TriangleAlert className="me-1.5 inline-block h-4 w-4" aria-hidden="true" />
      {localize('com_assistants_allow_sites_you_trust')}
    </p>
  );
}
