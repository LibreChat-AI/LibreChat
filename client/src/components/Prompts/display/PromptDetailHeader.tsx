import { format } from 'date-fns';
import { TooltipAnchor } from '@librechat/client';
import { User, Calendar, EarthIcon, BarChart3, Cloud } from 'lucide-react';
import type { TPromptGroup } from 'librechat-data-provider';
import { useLocalize, useAuthContext } from '~/hooks';
import CategoryIcon from '../utils/CategoryIcon';
import { isExternalPromptGroup } from '~/utils';

interface PromptDetailHeaderProps {
  group: TPromptGroup;
}

const PromptDetailHeader = ({ group }: PromptDetailHeaderProps) => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const formattedDate = group.createdAt ? format(new Date(group.createdAt), 'MMM d, yyyy') : null;
  const isSharedPrompt = group.author !== user?.id && Boolean(group.authorName);

  const isGlobalGroup = group.isPublic === true;
  const isExternal = isExternalPromptGroup(group);

  return (
    <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:gap-4">
      {group.category && (
        <div className="bg-surface-secondary flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
          <CategoryIcon category={group.category} className="h-6 w-6" />
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-text-primary truncate text-xl font-bold" title={group.name}>
            {group.name}
          </h2>
          {isGlobalGroup && (
            <TooltipAnchor
              description={localize('com_ui_sr_global_prompt')}
              side="top"
              render={
                <EarthIcon
                  className="text-accent-primary h-5 w-5 shrink-0"
                  aria-label={localize('com_ui_sr_global_prompt')}
                />
              }
            />
          )}
          {isExternal && (
            <TooltipAnchor
              description={localize('com_ui_prompt_source_langfuse')}
              side="top"
              render={
                <Cloud
                  className="text-text-secondary h-5 w-5 shrink-0"
                  aria-label={localize('com_ui_prompt_source_langfuse')}
                />
              }
            />
          )}
        </div>
        {group.oneliner && (
          <p className="text-text-secondary text-sm sm:truncate">{group.oneliner}</p>
        )}
        <div className="text-text-secondary mt-1 flex flex-wrap items-center gap-3 text-xs">
          {isSharedPrompt && (
            <span className="flex items-center gap-1">
              <User className="text-text-secondary h-3 w-3" aria-hidden="true" />
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
