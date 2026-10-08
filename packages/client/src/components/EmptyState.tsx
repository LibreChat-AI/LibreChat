import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '~/utils';

export interface EmptyStateProps {
  /** Decorative, drawn at a fixed size above the text. Any icon component with a
   *  `className` fits, so a Lucide glyph and a project SVG can share this state. */
  icon: LucideIcon | ComponentType<{ className?: string }>;
  /** Omitted for the "nothing matched your filter" shape, which is a line on its own. */
  title?: string;
  description?: string;
  /** A single call to action, e.g. a retry button. */
  action?: ReactNode;
  className?: string;
}

/**
 * The panel empty state: a circular icon, a title and a line of explanation, centred
 * in the space the list would have filled. Owned here because bookmarks, memories and
 * schedules each render the same thing, and three copies of one appearance means a
 * theme or spacing change has to be made three times and will eventually be made twice.
 *
 * It carries no border. An empty list is the absence of content, and drawing a box
 * around nothing turns a quiet state into the loudest element on the panel.
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center bg-transparent px-6 py-10 text-center',
        className,
      )}
    >
      <Icon className="text-text-tertiary mb-3 size-5 shrink-0" aria-hidden={true} />
      {title != null && <p className="text-text-primary text-sm font-medium">{title}</p>}
      {description != null && (
        // Without a title the description IS the message, so it carries the title's
        // size rather than reading as a caption under nothing.
        <p className={cn(title == null ? 'text-sm' : 'mt-0.5 text-xs', 'text-text-secondary')}>
          {description}
        </p>
      )}
      {action != null && <div className="mt-3">{action}</div>}
    </div>
  );
}
