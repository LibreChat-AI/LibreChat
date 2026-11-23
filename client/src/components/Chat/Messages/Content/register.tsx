import { ContentParts } from '@librechat/chat/components';
import { setAppContentParts } from './Parts/slots';
import { contentSlots } from './ContentParts';

/** Fills the parts host's content slot with the chat package's renderer and this app's slots.
 *  Omitted row fields take an assistant reply's defaults: not the user's, the last row, latest
 *  while it is submitting. */
setAppContentParts(
  ({ isCreatedByUser = false, isLast = true, isLatestMessage, isSubmitting, ...props }) => (
    <ContentParts
      {...props}
      slots={contentSlots}
      isCreatedByUser={isCreatedByUser}
      isLast={isLast}
      isSubmitting={isSubmitting}
      isLatestMessage={isLatestMessage ?? isSubmitting}
    />
  ),
);
