import { useTurns } from '@librechat/chat/react';
import type { ChatTurnsParams } from '@librechat/chat/react';
import useTurnServices from './services';

export {
  getRegenerateTargetResponseMessage,
  getRegenerateSubmissionMessages,
  getPreliminaryRegenerateResponseMessageId,
} from '@librechat/chat';

/** The package's `useTurns` over the app's services: what `useChatHelpers` runs for a pane. */
export default function useChatFunctions({
  index = 0,
  ...params
}: Omit<ChatTurnsParams, 'index'> & { index?: number }) {
  const turnsParams = { index, ...params };
  return useTurns(turnsParams, useTurnServices(turnsParams));
}
