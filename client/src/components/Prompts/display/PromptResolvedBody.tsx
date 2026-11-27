import { Button, Spinner } from '@librechat/client';
import { getPromptResolveErrorMessage } from '~/utils';
import PromptTextCard from './PromptTextCard';
import { useLocalize } from '~/hooks';

interface PromptResolvedBodyProps {
  mainText: string;
  isLoading: boolean;
  error: unknown;
  /** Re-issues the resolve request. Omitted hides the retry button. */
  onRetry?: () => void;
  /** Replaces the Langfuse loading copy, for a native revision read. */
  loadingLabel?: string;
}

/**
 * The loading / error / resolved-text block shared by `PromptDetails` and
 * `PromptForm`'s `ExternalPromptGroupView`, so a pending or failed Langfuse
 * resolve reads identically in both surfaces.
 */
const PromptResolvedBody = ({
  mainText,
  isLoading,
  error,
  onRetry,
  loadingLabel,
}: PromptResolvedBodyProps) => {
  const localize = useLocalize();

  if (isLoading) {
    return (
      <div className="text-text-secondary flex h-full flex-col items-center justify-center gap-2 text-sm">
        <Spinner className="size-5" aria-hidden="true" />
        <span>{loadingLabel ?? localize('com_ui_prompt_resolving')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-sm">
        <p role="alert" className="text-text-destructive text-center">
          {getPromptResolveErrorMessage(error, localize)}
        </p>
        {onRetry && (
          <Button type="button" variant="outline" onClick={onRetry}>
            {localize('com_ui_retry')}
          </Button>
        )}
      </div>
    );
  }

  return <PromptTextCard mainText={mainText} />;
};

export default PromptResolvedBody;
