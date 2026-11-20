import { ExternalLink } from 'lucide-react';
import type { TResolvedLangfusePrompt } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

interface LangfusePromptMetaProps {
  resolved: TResolvedLangfusePrompt;
}

/**
 * Version/labels line and deep link for a resolved Langfuse prompt, shared
 * between `PromptDetails` and `PromptForm`'s `ExternalPromptGroupView` so the
 * two surfaces render it identically. The server omits `sourceUrl` for a
 * non-admin requester (`toResolveResponse` in `packages/api/src/prompts/handlers.ts`),
 * so the link renders here whenever it is present.
 */
const LangfusePromptMeta = ({ resolved }: LangfusePromptMetaProps) => {
  const localize = useLocalize();
  const hasSourceUrl = Boolean(resolved.sourceUrl);

  return (
    <div className="text-text-secondary flex flex-wrap items-center gap-3 text-xs">
      <span>
        {localize('com_ui_prompt_version', { 0: resolved.version })}
        {resolved.labels.length > 0 ? ` · ${resolved.labels.join(', ')}` : ''}
      </span>
      {hasSourceUrl && (
        <a
          href={resolved.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-link hover:text-link-hover inline-flex items-center gap-1 hover:underline"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          {localize('com_ui_prompt_open_in_langfuse')}
        </a>
      )}
    </div>
  );
};

export default LangfusePromptMeta;
