import type { TPromptGroup } from 'librechat-data-provider';
import SharePrompt from '../dialogs/SharePrompt';
import UsePromptButton from './UsePromptButton';

interface PromptActionsProps {
  group: TPromptGroup;
  /** The prompt text `UsePromptButton` submits or detects variables in. */
  promptText: string;
  /** Forwarded to `UsePromptButton`: true while `promptText` is still being
   *  resolved (e.g. a live Langfuse read). */
  isLoading?: boolean;
  /** Forwarded to `UsePromptButton`: true when resolving `promptText` failed. */
  hasError?: boolean;
  onUsePrompt?: () => void;
  /** Forwarded to `UsePromptButton`: the chat composer's index, or undefined
   *  where there is no associated chat. */
  chatIndex?: number;
}

const PromptActions = ({
  group,
  promptText,
  isLoading = false,
  hasError = false,
  onUsePrompt,
  chatIndex,
}: PromptActionsProps) => {
  return (
    <div className="flex w-full gap-2 sm:justify-end sm:gap-3">
      <SharePrompt group={group} disabled={false} />

      <UsePromptButton
        group={group}
        promptText={promptText}
        isLoading={isLoading}
        hasError={hasError}
        onUsePrompt={onUsePrompt}
        chatIndex={chatIndex}
      />
    </div>
  );
};

export default PromptActions;
