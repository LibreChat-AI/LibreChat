import { setDefaultMessagesHost } from '@librechat/chat/react';
import type { MessagesHost } from '@librechat/chat/react';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import Files from '~/components/Chat/Messages/Content/Files';
import useClockFormat from '~/hooks/useClockFormat';

/** What the message list reads from the app: the viewer's clock format and the row pieces that
 *  still live here. Registered as the default when this module loads, so rows read it on every
 *  route, the shared view included. */
export const appMessagesHost: MessagesHost = {
  useHour12: useClockFormat,
  renderFiles: (message) => <Files message={message} />,
  renderMessageIcon: (props) => <MessageIcon {...props} />,
};

setDefaultMessagesHost(appMessagesHost);
