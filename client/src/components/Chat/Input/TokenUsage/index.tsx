import { memo } from 'react';
import { useAtom } from 'jotai';
import { Spinner } from '@librechat/client';
import { Constants } from 'librechat-data-provider';
import {
  CompactAction,
  ContextBreakdown as Breakdown,
  ContextGauge as Gauge,
  ContextUsagePopover as UsagePopover,
} from '@librechat/chat/components';
import type { TConversation } from 'librechat-data-provider';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import type { CurrencyConfig } from '~/utils';
import useCompactConversation, { supportsCompaction } from '~/hooks/Chat/useCompactConversation';
import { useGetLangfuseSessionLinkQuery, useGetStartupConfig } from '~/data-provider';
import useTokenUsage from '~/hooks/Chat/useTokenUsage';
import { contextBreakdownExpandedAtom } from './store';
import { formatTokens } from '~/utils';
import { useLocalize } from '~/hooks';

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
  const [breakdownExpanded, setBreakdownExpanded] = useAtom(contextBreakdownExpandedAtom);
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
        currency={currency}
        langfuseSessionUrl={langfuseSession?.url ?? undefined}
        expanded={breakdownExpanded}
        onExpandedChange={setBreakdownExpanded}
      />
      {compactionAvailable && (
        <>
          <div className="border-border-light border-t" role="separator" />
          <CompactAction
            reclaimableTokens={view.compactionReclaim}
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
}: TokenUsageProps & {
  showCost: boolean;
  currency?: CurrencyConfig;
  langfuseConnectionAccess: boolean;
  compactionEnabled: boolean;
}) {
  const localize = useLocalize();
  const view = useTokenUsage({ index, conversation, isSubmitting });
  /** Owned here, not in the popover: `unmountOnHide` would otherwise lose the
   *  in-flight state the moment the pointer leaves. */
  const compaction = useCompactConversation();
  const compactionAvailable = compactionEnabled && supportsCompaction(conversation?.endpoint);
  const conversationId = conversation?.conversationId ?? '';
  const hasContext = view.usedTokens > 0;

  if (!hasContext) {
    return null;
  }

  const hasMax = view.maxTokens != null && view.maxTokens > 0;
  const usageAriaLabel = hasMax
    ? localize('com_ui_context_usage_label', {
        0: formatTokens(view.usedTokens),
        1: formatTokens(view.maxTokens ?? 0),
        2: String(Math.round(view.percent)),
      })
    : localize('com_ui_context_usage_label_unknown', { 0: formatTokens(view.usedTokens) });
  const ariaLabel = compaction.isCompacting
    ? localize('com_ui_context_compacting')
    : usageAriaLabel;

  return (
    <UsagePopover
      resetKey={conversationId}
      label={ariaLabel}
      cardLabel={localize('com_ui_context_usage')}
      busy={compaction.isCompacting}
      trigger={(open) =>
        compaction.isCompacting && !open ? (
          <Spinner tone="secondary" className="size-5" />
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
      <div className="flex w-96 max-w-full flex-col gap-3" data-testid="token-usage-card">
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
  if (startupConfig.interface?.contextUsage === false) {
    return null;
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
    />
  );
});

export default TokenUsage;
