import { format } from 'date-fns';
import { TooltipAnchor } from '@librechat/client';
import { User, Calendar, EarthIcon, BarChart3 } from 'lucide-react';
import type { TPromptGroup } from 'librechat-data-provider';
import { useLocalize, useAuthContext } from '~/hooks';
import CategoryIcon from '../utils/CategoryIcon';

interface PromptDetailHeaderProps {
  group: TPromptGroup;
}

const PromptDetailHeader = ({ group }: PromptDetailHeaderProps) => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const formattedDate = group.createdAt ? format(new Date(group.createdAt), 'MMM d, yyyy') : null;
  const isSharedPrompt = group.author !== user?.id && Boolean(group.authorName);

  const isGlobalGroup = group.isPublic === true;

  return (
    <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:gap-4">
      {group.category && (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-secondary">
          <CategoryIcon category={group.category} className="h-6 w-6" />
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-xl font-bold text-text-primary" title={group.name}>
            {group.name}
          </h2>
          {isGlobalGroup && (
            <TooltipAnchor
              description={localize('com_ui_sr_global_prompt')}
              side="top"
              render={
                <EarthIcon
                  className="h-5 w-5 shrink-0 text-accent-primary"
                  aria-label={localize('com_ui_sr_global_prompt')}
                />
              }
            />
          )}
        </div>
        {group.oneliner && (
          <p className="text-sm text-text-secondary sm:truncate">{group.oneliner}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
          {isSharedPrompt && (
            <span className="flex items-center gap-1">
              <User className="h-3 w-3 text-text-secondary" aria-hidden="true" />
              {localize('com_ui_by_author', { 0: group.authorName })}
            </span>
          )}
          {formattedDate && (
            <time className="flex items-center gap-1" dateTime={group.createdAt?.toString()}>
              <Calendar className="h-3 w-3" aria-hidden="true" />
              {formattedDate}
            </time>
          )}
          {group.numberOfGenerations != null && group.numberOfGenerations > 0 && (
            <span className="flex items-center gap-1">
              <BarChart3 className="h-3 w-3" aria-hidden="true" />
              {localize('com_ui_usage')}: {group.numberOfGenerations}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default PromptDetailHeader;
