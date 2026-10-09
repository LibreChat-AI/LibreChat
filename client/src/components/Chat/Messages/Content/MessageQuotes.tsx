import { memo } from 'react';
import { TextQuote } from 'lucide-react';
import { useLocalize } from '~/hooks';

/**
 * Renders the verbatim excerpts a user quoted on a submitted message as
 * compact reference blocks above the message text. Presentational — takes
 * only the scalar `quotes` array (not the full message) so `React.memo`
 * comparisons on parent wrappers stay shallow.
 *
 * The backend persists `message.quotes`, so callers pass
 * `quotes={message.quotes}` and the references survive reload and history
 * renders, mirroring how `SkillPills` reads `message.manualSkills`.
 */
function MessageQuotes({ quotes }: { quotes?: string[] }) {
  const localize = useLocalize();

  if (!quotes || quotes.length === 0) {
    return null;
  }

  return (
    <div
      className="flex w-full flex-col gap-1.5"
      role="list"
      aria-label={localize('com_ui_referenced_quotes')}
      data-testid="message-quotes"
    >
      {quotes.map((text, index) => (
        <div
          key={`${index}-${text.slice(0, 24)}`}
          role="listitem"
          className="border-border-chrome bg-surface-secondary text-text-secondary flex items-start gap-1.5 rounded-2xl border px-2.5 py-1.5 text-sm"
        >
          <TextQuote
            className="text-text-tertiary mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="line-clamp-3 break-words whitespace-pre-wrap">{text}</span>
        </div>
      ))}
    </div>
  );
}

export default memo(MessageQuotes);
