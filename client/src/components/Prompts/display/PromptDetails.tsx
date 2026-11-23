import { useMemo } from 'react';
import { SquareSlash } from 'lucide-react';
import { replaceSpecialVars } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import { useLocalize, useAuthContext, usePromptContent } from '~/hooks';
import LangfusePromptMeta from './LangfusePromptMeta';
import PromptDetailHeader from './PromptDetailHeader';
import PromptResolvedBody from './PromptResolvedBody';
import PromptVariables from './PromptVariables';
import PromptActions from './PromptActions';

interface PromptDetailsProps {
  group?: TPromptGroup;
  showActions?: boolean;
  onUsePrompt?: () => void;
  /** The chat composer's index, forwarded to `PromptActions` so its Use
   *  button can close a variable dialog opened from this view on a chat
   *  change; undefined where there is no associated chat (`PromptForm`'s
   *  `showActions={false}` read-only view). */
  chatIndex?: number;
}

const PromptDetails = ({
  group,
  showActions = true,
  onUsePrompt,
  chatIndex,
}: PromptDetailsProps) => {
  const localize = useLocalize();
  const { user } = useAuthContext();

  const { text, resolved, isLoading, error, refetch } = usePromptContent(group);
  const hasError = Boolean(error);

  const mainText = useMemo(() => replaceSpecialVars({ text, user }), [text, user]);

  if (!group) {
    return null;
  }

  return (
    <article
      className="flex max-h-[80vh] min-w-0 flex-col gap-3 overflow-hidden p-1 sm:gap-4 sm:p-2"
      aria-label={localize('com_ui_prompt_details', { name: group.name })}
    >
      <h1 className="sr-only">{group.name}</h1>
      <PromptDetailHeader group={group} />

      <div className="min-h-0 flex-1">
        <PromptResolvedBody
          mainText={mainText}
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
        />
      </div>

      {!isLoading && !hasError && <PromptVariables promptText={mainText} />}

      {resolved?.source === 'langfuse' && <LangfusePromptMeta resolved={resolved} />}

      {group.command && (
        <div className="border-border-medium flex items-center gap-2 rounded-xl border bg-transparent p-3">
          <SquareSlash className="text-text-secondary h-4 w-4" aria-hidden="true" />
          <span className="text-text-primary font-mono text-sm">/{group.command}</span>
        </div>
      )}

      {showActions && (
        <PromptActions
          group={group}
          promptText={mainText}
          isLoading={isLoading}
          hasError={hasError}
          onUsePrompt={onUsePrompt}
          chatIndex={chatIndex}
        />
      )}
    </article>
  );
};

export default PromptDetails;
