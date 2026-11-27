import { useMemo } from 'react';
import { SquareSlash } from 'lucide-react';
import { replaceSpecialVars } from 'librechat-data-provider';
import type {
  TPromptGroup,
  PromptSelection,
  TResolvedPromptResponse,
} from 'librechat-data-provider';
import {
  isExternalPromptGroup,
  PromptRevisionNotFoundError,
  PromptContentBlockedError,
} from '~/utils';
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
  /** The revision to show. Defaults to Production. */
  selection?: PromptSelection;
  /** False shows the raw template, with `{{current_user}}` and the other
   *  special variables as written. */
  substituteVariables?: boolean;
  /** Labels the shown revision next to the group name. Receives the live
   *  Langfuse read, so a label can name the version that Production resolved to. */
  getVersionLabel?: (resolved: TResolvedPromptResponse | undefined) => string;
}

const PromptDetails = ({
  group,
  showActions = true,
  onUsePrompt,
  chatIndex,
  selection,
  substituteVariables = true,
  getVersionLabel,
}: PromptDetailsProps) => {
  const localize = useLocalize();
  const { user } = useAuthContext();

  const { text, resolved, isLoading, error, refetch } = usePromptContent(group, { selection });
  const hasError = Boolean(error);
  // Retrying cannot bring back a deleted revision or unblock a blocked one.
  const canRetry = !(
    error instanceof PromptRevisionNotFoundError || error instanceof PromptContentBlockedError
  );

  const mainText = useMemo(
    () => (substituteVariables ? replaceSpecialVars({ text, user }) : text),
    [substituteVariables, text, user],
  );

  if (!group) {
    return null;
  }

  return (
    <article
      className="flex max-h-[80vh] min-w-0 flex-col gap-3 overflow-hidden p-1 sm:gap-4 sm:p-2"
      aria-label={localize('com_ui_prompt_details', { name: group.name })}
    >
      <h1 className="sr-only">{group.name}</h1>
      <PromptDetailHeader group={group} versionLabel={getVersionLabel?.(resolved)} />

      <div className="min-h-0 flex-1">
        <PromptResolvedBody
          mainText={mainText}
          isLoading={isLoading}
          error={error}
          onRetry={canRetry ? refetch : undefined}
          loadingLabel={isExternalPromptGroup(group) ? undefined : localize('com_ui_loading')}
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
