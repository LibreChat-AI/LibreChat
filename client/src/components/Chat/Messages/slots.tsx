import type { ChatScreenMessagesSlots } from '@librechat/chat/components';
import PendingSteers from './Content/Parts/PendingSteers';
import PendingTurn from './PendingTurn';
import { FLAT_THREAD } from './Thread';
import './hosts';

/** The app's pieces of the package message list, loaded with it. */
export const messagesSlots: ChatScreenMessagesSlots = {
  flatThread: FLAT_THREAD,
  renderPendingTurn: (props) => <PendingTurn {...props} />,
  renderPendingSteers: (props) => <PendingSteers {...props} />,
};
