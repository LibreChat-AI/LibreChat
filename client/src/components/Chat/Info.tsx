import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Constants } from 'librechat-data-provider';
import { OGDialog, OGDialogTemplate } from '@librechat/client';
import { CopyButton, ContextUsage as Usage } from '@librechat/chat/components';
import {
  EMPTY_USAGE,
  addUsage,
  mergeUsage,
  readPersistedUsage,
  pendingToBranchUsage,
} from '@librechat/chat';
import {
  totalUsageFamily,
  pendingUsageFamily,
  subagentUsageFamily,
  pendingSubagentUsageFamily,
} from '@librechat/chat/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode, RefObject } from 'react';
import type { CurrencyConfig } from '~/utils';
import { useCopyToClipboard, useLocalize } from '~/hooks';
import { useCachedMessages } from '~/data-provider';
import useClockFormat from '~/hooks/useClockFormat';

interface InfoProps {
  conversation: TConversation;
  showUsage: boolean;
  showCost: boolean;
  currency?: CurrencyConfig;
}

function summarizeMessages(messages: TMessage[]) {
  const summary = {
    messages: messages.length,
    responses: 0,
    recorded: 0,
    usage: { ...EMPTY_USAGE },
  };
  for (const message of messages) {
    if (message.isCreatedByUser) {
      continue;
    }
    summary.responses++;
    const usage = readPersistedUsage(message);
    if (usage != null) {
      summary.recorded++;
      addUsage(summary.usage, usage);
    }
  }
  return summary;
}

function Detail({ label, children }: { label: string; children?: ReactNode }) {
  if (children == null || children === '') {
    return null;
  }
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-text-secondary text-xs">{label}</dt>
      <dd className="text-sm break-words tabular-nums">{children}</dd>
    </div>
  );
}

/** Reads the existing message cache and usage rollup only while the dialog is open. */
function Details({ conversation, showUsage, showCost, currency }: InfoProps) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const hour12 = useClockFormat();
  const conversationId = conversation.conversationId ?? '';
  const { data: summary } = useCachedMessages(conversationId, summarizeMessages);
  const committed = useAtomValue(totalUsageFamily(conversationId));
  const pending = useAtomValue(pendingUsageFamily(conversationId));
  const subagentUsage = useAtomValue(subagentUsageFamily(conversationId));
  const pendingSubagentUsage = useAtomValue(pendingSubagentUsageFamily(conversationId));
  const subagents = mergeUsage(subagentUsage, pendingSubagentUsage);
  // Read-only threads may have no composer to hydrate the shared rollup.
  const usage = mergeUsage(
    committed === EMPTY_USAGE ? (summary?.usage ?? EMPTY_USAGE) : committed,
    pendingToBranchUsage(pending),
  );
  const hasUsage =
    (summary?.recorded ?? 0) > 0 ||
    pending.eventCount > 0 ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.cost > 0;
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short', hour12 }),
    [i18n.language, hour12],
  );
  const date = (value?: string) => {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? formatter.format(parsed) : undefined;
  };
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = useCopyToClipboard({ text: conversationId });

  return (
    <div
      className="max-h-[65dvh] space-y-6 overflow-y-auto overscroll-contain"
      data-testid="conversation-info-details"
    >
      <dl className="grid grid-cols-2 gap-4">
        <div className="col-span-2 min-w-0">
          <dt className="text-text-secondary text-xs">{localize('com_ui_conversation_id')}</dt>
          <dd className="mt-1">
            <div className="flex items-center justify-between gap-3">
              <code className="min-w-0 text-xs break-all" dir="ltr">
                {conversationId}
              </code>
              <CopyButton
                iconOnly
                compact
                label={localize('com_ui_conversation_copy_id')}
                isCopied={copied}
                onClick={() => setCopyFailed(!copy(setCopied))}
              />
            </div>
            {copyFailed && (
              <p className="text-text-destructive mt-1 text-xs" role="status">
                {localize('com_ui_copy_failed')}
              </p>
            )}
          </dd>
        </div>
        <Detail label={localize('com_ui_created')}>{date(conversation.createdAt)}</Detail>
        <Detail label={localize('com_ui_conversation_updated')}>
          {date(conversation.updatedAt)}
        </Detail>
        <Detail label={localize('com_ui_conversation_messages')}>
          {summary?.messages ?? conversation.messages?.length}
        </Detail>
        <Detail label={localize('com_ui_conversation_responses')}>{summary?.responses}</Detail>
      </dl>

      <section
        className="border-border-light space-y-4 border-t pt-4"
        aria-label={localize('com_ui_conversation_configuration')}
      >
        <h3 className="text-sm font-semibold">{localize('com_ui_conversation_configuration')}</h3>
        <dl className="grid grid-cols-2 gap-4">
          <Detail label={localize('com_ui_endpoint')}>{conversation.endpoint}</Detail>
          <Detail label={localize('com_ui_model')}>
            {conversation.model ?? conversation.modelLabel}
          </Detail>
          <Detail label={localize('com_ui_agent_id')}>{conversation.agent_id}</Detail>
          <Detail label={localize('com_ui_conversation_assistant_id')}>
            {conversation.assistant_id}
          </Detail>
          <Detail label={localize('com_ui_model_spec')}>{conversation.spec}</Detail>
          <Detail label={localize('com_ui_conversation_context_limit')}>
            {conversation.maxContextTokens?.toLocaleString(i18n.language)}
          </Detail>
          <Detail label={localize('com_endpoint_max_output_tokens')}>
            {(conversation.maxOutputTokens ?? conversation.max_tokens)?.toLocaleString(
              i18n.language,
            )}
          </Detail>
          <Detail label={localize('com_endpoint_temperature')}>{conversation.temperature}</Detail>
          <Detail label={localize('com_endpoint_top_p')}>
            {conversation.topP ?? conversation.top_p}
          </Detail>
        </dl>
      </section>

      {showUsage && (
        <div className="border-border-light border-t pt-4">
          <Usage
            disclosure={false}
            title={localize('com_ui_conversation_usage')}
            usage={hasUsage ? usage : undefined}
            unavailable={localize('com_ui_conversation_usage_unavailable')}
            cost={showCost && hasUsage && usage.costKnown ? usage.cost : undefined}
            costLabel={localize('com_ui_context_cost_total')}
            currency={currency}
            subagentTokens={
              subagents.input + subagents.output + subagents.cacheRead + subagents.cacheWrite
            }
            testId="conversation-total-usage"
          />
        </div>
      )}
    </div>
  );
}

export default function ConversationInfo({
  open,
  onOpenChange,
  triggerRef,
  ...props
}: InfoProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  const localize = useLocalize();
  const label = localize('com_ui_conversation_info');
  const id = props.conversation.conversationId;
  if (!id || id === Constants.NEW_CONVO || id === Constants.PENDING_CONVO) {
    return null;
  }

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        title={label}
        description={props.conversation.title ?? ''}
        className="max-w-lg"
        showCloseButton
        showCancelButton={false}
        main={open ? <Details {...props} /> : null}
      />
    </OGDialog>
  );
}
