import type { ReactNode } from 'react';
import type { ContentPartsSlotProps } from '../react/host';
import type { ContentPartsSlots } from './contentTypes';
import { ContentParts } from './ContentParts';

/**
 * Builds the host's `renderContentParts` from the package's `ContentParts` and what the host adds
 * to it. Row fields the caller leaves out take an assistant reply's defaults: not the user's, the
 * last row, and latest while it is submitting. `slots` must stay the same object; see
 * `ContentPartsSlots`.
 */
export function contentPartsRenderer(
  slots?: ContentPartsSlots,
): (props: ContentPartsSlotProps) => ReactNode {
  return function renderContentParts({
    isCreatedByUser = false,
    isLast = true,
    isLatestMessage,
    isSubmitting,
    ...props
  }: ContentPartsSlotProps): ReactNode {
    return (
      <ContentParts
        {...props}
        slots={slots}
        isCreatedByUser={isCreatedByUser}
        isLast={isLast}
        isSubmitting={isSubmitting}
        isLatestMessage={isLatestMessage ?? isSubmitting}
      />
    );
  };
}

/** How a message's parts are drawn when the host names no renderer: `ContentParts`, no slots. */
export const renderContentParts: (props: ContentPartsSlotProps) => ReactNode =
  contentPartsRenderer();
