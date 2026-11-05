import { setAppContentParts } from './Parts/slots';
import ContentParts from './ContentParts';

/** Fills the parts host's content slot with the app's renderer. Omitted row fields take an
 *  assistant reply's defaults: not the user's, the last row, latest while it is submitting. */
setAppContentParts(
  ({ isCreatedByUser = false, isLast = true, isLatestMessage, isSubmitting, ...props }) => (
    <ContentParts
      {...props}
      isCreatedByUser={isCreatedByUser}
      isLast={isLast}
      isSubmitting={isSubmitting}
      isLatestMessage={isLatestMessage ?? isSubmitting}
    />
  ),
);
