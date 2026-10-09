import { useTranslation } from 'react-i18next';
import useClockFormat from '~/hooks/useClockFormat';
import { cn, getMessageTimestamp } from '~/utils';
import useTimeTick from '~/hooks/useTimeTick';

type Timestamp = NonNullable<ReturnType<typeof getMessageTimestamp>>;

function TimestampText({
  timestamp,
  className,
  revealOnHover = true,
}: {
  timestamp: Timestamp;
  className?: string;
  revealOnHover?: boolean;
}) {
  return (
    <time
      dateTime={timestamp.iso}
      title={timestamp.isRecent ? timestamp.absolute : undefined}
      className={cn(
        'message-timestamp text-xs font-normal text-text-secondary',
        revealOnHover &&
          'ml-2 transition-opacity duration-theme-normal ease-out motion-reduce:transition-none',
        className,
      )}
    >
      {timestamp.isRecent ? timestamp.relative : timestamp.absolute}
    </time>
  );
}

/** Only recent timestamps subscribe to the shared minute ticker, so the
 * per-minute sweep re-renders a handful of rows instead of every message. */
function RecentTimestamp({
  value,
  language,
  hour12,
  className,
  revealOnHover,
}: {
  value?: string | null;
  language: string;
  hour12: boolean;
  className?: string;
  revealOnHover?: boolean;
}) {
  useTimeTick();
  const timestamp = getMessageTimestamp(value, language, hour12);

  if (!timestamp) {
    return null;
  }

  return (
    <TimestampText timestamp={timestamp} className={className} revealOnHover={revealOnHover} />
  );
}

/**
 * Inline message timestamp shown next to the author name in the message header.
 * On hover-capable pointers it reveals on row hover/focus; on touch and other
 * non-hover devices it stays visible. Recent messages show the relative form
 * ("10 minutes ago") with the absolute date on hover; older messages show the
 * absolute date directly.
 */
export default function MessageTimestamp({
  value,
  className,
  revealOnHover,
}: {
  value?: string | null;
  className?: string;
  revealOnHover?: boolean;
}) {
  const { i18n } = useTranslation();
  const hour12 = useClockFormat();
  const timestamp = getMessageTimestamp(value, i18n.language, hour12);

  if (!timestamp) {
    return null;
  }

  if (timestamp.isRecent) {
    return (
      <RecentTimestamp
        value={value}
        language={i18n.language}
        hour12={hour12}
        className={className}
        revealOnHover={revealOnHover}
      />
    );
  }

  return (
    <TimestampText timestamp={timestamp} className={className} revealOnHover={revealOnHover} />
  );
}
