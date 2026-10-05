import { memo } from 'react';
import { Spinner } from '@librechat/client';
import { Constants } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import type { CurrencyConfig } from '~/utils';
import useCompactConversation, { supportsCompaction } from '~/hooks/Chat/useCompactConversation';
import { useGetLangfuseSessionLinkQuery, useGetStartupConfig } from '~/data-provider';
import Balance, { Summary as BalanceSummary } from '~/components/Balance';
import useBalanceSummary from '~/hooks/useBalanceSummary';
import useTokenUsage from '~/hooks/Chat/useTokenUsage';
import CompactAction from './CompactAction';
import { formatTokens } from '~/utils';
import { useLocalize } from '~/hooks';
import UsagePopover from './Popover';
import Breakdown from './Breakdown';
import Gauge from './Gauge';

interface TokenUsageProps {
  index: number;
  conversation: TConversation | null;
  isSubmitting: boolean;
}

interface ContextCardProps {
  view: TokenUsageView;
  conversationId: string;
  isSubmitting: boolean;
  showCost: boolean;
  currency?: CurrencyConfig;
  langfuseConnectionAccess: boolean;
  compaction: ReturnType<typeof useCompactConversation>;
  compactionAvailable: boolean;
}

/** The context half of the card. Mounted only while the card is open, so the
 *  Langfuse session link resolves on demand rather than per conversation. */
function ContextCard({
  view,
  conversationId,
  isSubmitting,
  showCost,
  currency,
  langfuseConnectionAccess,
  compaction,
  compactionAvailable,
}: ContextCardProps) {
  const canResolveLangfuseSession =
    langfuseConnectionAccess &&
    !isSubmitting &&
    conversationId !== '' &&
    conversationId !== Constants.NEW_CONVO &&
    conversationId !== Constants.PENDING_CONVO;
  const { data: langfuseSession } = useGetLangfuseSessionLinkQuery(
    conversationId,
    canResolveLangfuseSession,
  );

  return (
    <>
      <Breakdown
        view={view}
        showCost={showCost}
        compactionAvailable={compactionAvailable}
        currency={currency}
        langfuseSessionUrl={langfuseSession?.url ?? undefined}
      />
      {compactionAvailable && (
        <>
          <div className="border-border-light border-t" role="separator" />
          <CompactAction
            compact={compaction.compact}
            canCompact={compaction.canCompact}
            isCompacting={compaction.isCompacting}
          />
        </>
      )}
    </>
  );
}

function TokenUsageIndicator({
  index,
  conversation,
  isSubmitting,
  showCost,
  currency,
  langfuseConnectionAccess,
  compactionEnabled,
  balanceEnabled,
}: TokenUsageProps & {
  showCost: boolean;
  currency?: CurrencyConfig;
  langfuseConnectionAccess: boolean;
  compactionEnabled: boolean;
  balanceEnabled: boolean;
}) {
  const localize = useLocalize();
  const view = useTokenUsage({ index, conversation, isSubmitting });
  /** Owned here, not in the popover: `unmountOnHide` would otherwise lose the
   *  in-flight state the moment the pointer leaves. */
  const compaction = useCompactConversation();
  const compactionAvailable = compactionEnabled && supportsCompaction(conversation?.endpoint);
  const conversationId = conversation?.conversationId ?? '';
  const hasContext = view.usedTokens > 0;

  /** Without balance, hide until the branch has data — keeps a fresh,
   *  message-less chat clean and lets the indicator animate into view once the
   *  first tokens land. With balance, the card always has something to show. */
  if (!hasContext && !balanceEnabled) {
    return null;
  }

  const hasMax = view.maxTokens != null && view.maxTokens > 0;
  let usageAriaLabel = localize('com_nav_balance');
  if (hasContext) {
    usageAriaLabel = hasMax
      ? localize('com_ui_context_usage_label', {
          0: formatTokens(view.usedTokens),
          1: formatTokens(view.maxTokens ?? 0),
          2: String(Math.round(view.percent)),
        })
      : localize('com_ui_context_usage_label_unknown', { 0: formatTokens(view.usedTokens) });
  }
  const ariaLabel = compaction.isCompacting
    ? localize('com_ui_context_compacting')
    : usageAriaLabel;

  return (
    <UsagePopover
      resetKey={conversationId}
      label={ariaLabel}
      cardLabel={localize(hasContext ? 'com_ui_context_usage' : 'com_nav_balance')}
      busy={compaction.isCompacting}
      trigger={(open) =>
        compaction.isCompacting && !open ? (
          <Spinner className="text-text-secondary size-5" />
        ) : (
          <span
            role="meter"
            aria-valuemin={0}
            aria-valuemax={hasMax ? view.maxTokens : undefined}
            aria-valuenow={view.usedTokens}
            aria-label={localize('com_ui_context_usage')}
            className="flex items-center justify-center"
          >
            <Gauge percent={view.percent} indeterminate={hasContext && !hasMax} />
          </span>
        )
      }
    >
      {/* The popover owns its width, which the breakdown held only while it
          was the sole child of a shrink-to-fit box. */}
      <div className="w-72 max-w-full space-y-3">
        {hasContext && (
          <ContextCard
            view={view}
            conversationId={conversationId}
            isSubmitting={isSubmitting}
            showCost={showCost}
            currency={currency}
            langfuseConnectionAccess={langfuseConnectionAccess}
            compaction={compaction}
            compactionAvailable={compactionAvailable}
          />
        )}
        {balanceEnabled && (
          <Balance className={hasContext ? 'border-border-light border-t pt-3' : undefined} />
        )}
      </div>
    </UsagePopover>
  );
}

/** The gauge for a deployment that turned context usage off but meters credits:
 *  its ring is the share of the balance allotment spent. */
function BalanceIndicator({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const { state, currency } = useBalanceSummary();
  if (state.status === 'empty') {
    return null;
  }
  const summary = state.status === 'success' ? state.summary : null;
  const usedPercent = summary?.usedPercent ?? null;
  const label = localize('com_nav_balance');

  return (
    <UsagePopover
      resetKey={conversationId}
      label={label}
      cardLabel={label}
      busy={state.status === 'loading'}
      trigger={() =>
        /** A meter has no indeterminate state: until there is a share to report
         *  (loading, failed, nothing to measure against) the ring is decoration
         *  and the button's label carries the name. */
        usedPercent != null ? (
          <span
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPercent}
            aria-label={localize('com_ui_balance_used_label')}
            className="flex items-center justify-center"
          >
            <Gauge percent={usedPercent} indeterminate={false} tone={summary?.tone} />
          </span>
        ) : (
          <span aria-hidden="true" className="flex items-center justify-center">
            <Gauge percent={0} indeterminate />
          </span>
        )
      }
    >
      <div className="w-72 max-w-full">
        <BalanceSummary state={state} currency={currency} />
      </div>
    </UsagePopover>
  );
}

/** Config gate kept outside the indicator so disabled deployments mount nothing */
const TokenUsage = memo(function TokenUsage(props: TokenUsageProps) {
  const { data: startupConfig } = useGetStartupConfig();
  /** Wait for config before mounting: until it loads `contextUsage === false`
   *  reads as undefined, so a disabled deployment would briefly mount the
   *  indicator and fire the token-config query on first load */
  if (startupConfig == null) {
    return null;
  }
  const balanceEnabled = startupConfig.balance?.enabled === true;
  if (startupConfig.interface?.contextUsage === false) {
    return balanceEnabled ? (
      <BalanceIndicator conversationId={props.conversation?.conversationId ?? ''} />
    ) : null;
  }
  return (
    <TokenUsageIndicator
      {...props}
      showCost={startupConfig.interface?.contextCost === true}
      currency={startupConfig.interface?.currency}
      langfuseConnectionAccess={startupConfig.langfuseConnectionAccess === true}
      /** Same `summarization.enabled` switch that governs the automatic detour,
       *  advertised positively: a server that does not know the capability
       *  (a cached config from an older release) must not receive the request,
       *  which it would run as an empty, billed ordinary turn. */
      compactionEnabled={startupConfig.compactionEnabled === true}
      balanceEnabled={balanceEnabled}
    />
  );
});

export default TokenUsage;
