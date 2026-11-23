import { Button } from '@librechat/client';
import { Constants } from 'librechat-data-provider';
import type { CSSProperties, ReactElement } from 'react';

export type ChatStartersProps = {
  /** The suggested first messages; only the first `MAX_CONVO_STARTERS` are offered. */
  starters: string[];
  /** Sends the chosen suggestion. */
  onSelect: (text: string) => void;
};

/** The suggested first messages on the welcome screen, each one sent as it is when chosen. */
export default function ChatStarters({
  starters,
  onSelect,
}: ChatStartersProps): ReactElement | null {
  if (starters.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 mb-8 flex w-full flex-wrap items-stretch justify-center gap-2 px-4">
      {starters.slice(0, Constants.MAX_CONVO_STARTERS).map((text, index) => (
        <Button
          key={index}
          variant="starter"
          className="max-w-64"
          onClick={() => onSelect(text)}
          style={{ '--starter-delay': `${index * 75}ms` } as CSSProperties}
        >
          <span className="line-clamp-2 text-balance break-words">{text}</span>
        </Button>
      ))}
    </div>
  );
}
