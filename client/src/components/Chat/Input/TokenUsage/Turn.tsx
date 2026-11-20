import { useMemo } from 'react';
import { Info } from 'lucide-react';
import { atom, useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { activeUsageResponseIdFamily, pendingUsageFamily } from '@librechat/chat/react';
import { registry, stickyUsage, readPersistedUsage, pendingToBranchUsage } from '@librechat/chat';
import {
  ContextUsage as Usage,
  ContextUsagePopover as UsagePopover,
} from '@librechat/chat/components';
import type { MessageUsageProps } from '@librechat/chat/react';
import type { CurrencyConfig } from '~/utils';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

/** Only the open card subscribes to live usage; historical message rows stay idle. */
function TurnDetails({
  message,
  conversationId,
  showCost,
  currency,
}: MessageUsageProps & { conversationId: string; showCost: boolean; currency?: CurrencyConfig }) {
  const localize = useLocalize();
  const activeResponseId = useAtomValue(activeUsageResponseIdFamily(conversationId));
  const pending = useAtomValue(pendingUsageFamily(conversationId));
  const inProgress = activeResponseId === message.messageId;
  let usage =
    readPersistedUsage(message) ??
    registry.get(conversationId)?.get(message.messageId)?.usage ??
    stickyUsage(conversationId, message.messageId);
  if (inProgress) {
    usage = pending.eventCount > 0 ? pendingToBranchUsage(pending) : undefined;
  }

  return (
    <Usage
      disclosure={false}
      title={localize(inProgress ? 'com_ui_context_current_turn' : 'com_ui_context_turn_usage')}
      usage={usage}
      unavailable={localize(
        inProgress ? 'com_ui_context_waiting_usage' : 'com_ui_context_unavailable_usage',
      )}
      cost={showCost && usage?.costKnown ? usage.cost : undefined}
      costLabel={localize('com_ui_context_cost')}
      currency={currency}
      testId="message-turn-usage"
    />
  );
}

export default function Turn({ message, conversationId, isLast }: MessageUsageProps) {
  const localize = useLocalize();
  const { data: config } = useGetStartupConfig();
  const conversationKey = conversationId ?? message.conversationId ?? Constants.NEW_CONVO;
  const messageId = message.messageId;
  const hasPersistedUsage = readPersistedUsage(message) != null;
  /** Historical rows observe turn ownership, not every live usage event. */
  const availableAtom = useMemo(
    () =>
      atom((get) => {
        if (get(activeUsageResponseIdFamily(conversationKey)) === messageId) {
          return get(pendingUsageFamily(conversationKey)).eventCount > 0;
        }
        return (
          hasPersistedUsage ||
          registry.get(conversationKey)?.get(messageId)?.usage != null ||
          stickyUsage(conversationKey, messageId) != null
        );
      }),
    [conversationKey, messageId, hasPersistedUsage],
  );
  const hasUsage = useAtomValue(availableAtom);
  if (
    config == null ||
    config.interface?.contextUsage === false ||
    message.isCreatedByUser ||
    !hasUsage
  ) {
    return null;
  }
  const label = localize('com_ui_context_turn_usage');

  return (
    <UsagePopover
      resetKey={`${conversationKey}:${message.messageId}`}
      label={label}
      cardLabel={label}
      triggerVariant={isLast ? 'message-hover' : 'message-hover-reveal'}
      testId="message-usage-button"
      trigger={() => <Info className="size-4.75" aria-hidden="true" />}
    >
      <div className="w-72 max-w-full" data-usage-stage="details">
        <TurnDetails
          message={message}
          conversationId={conversationKey}
          showCost={config.interface?.contextCost === true}
          currency={config.interface?.currency}
        />
      </div>
    </UsagePopover>
  );
}
