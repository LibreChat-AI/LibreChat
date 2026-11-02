import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@librechat/client';
import type { BranchUsage } from '~/utils/tokens';
import type { CurrencyConfig } from '~/utils';
import { formatTokens, formatCost, normalizeTokenCount, cn } from '~/utils';
import { useLocalize } from '~/hooks';

interface UsageProps {
  title: string;
  subtitle?: string;
  usage?: BranchUsage;
  unavailable?: string;
  cost?: number;
  costLabel: string;
  currency?: CurrencyConfig;
  subagentTokens?: number;
  testId: string;
}

export default function Usage({
  title,
  subtitle,
  usage,
  unavailable,
  cost,
  costLabel,
  currency,
  subagentTokens = 0,
  testId,
}: UsageProps) {
  const localize = useLocalize();
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const rows =
    usage == null
      ? []
      : [
          { label: localize('com_ui_context_uncached_input'), value: usage.input },
          { label: localize('com_ui_output'), value: usage.output },
          { label: localize('com_ui_cache_read'), value: usage.cacheRead },
          { label: localize('com_ui_cache_write'), value: usage.cacheWrite },
        ];
  if (subagentTokens > 0) {
    rows.push({ label: localize('com_ui_context_subagents_all'), value: subagentTokens });
  }
  const reading = (detailed: boolean) => (
    <dl
      className={cn(
        'tabular-nums',
        detailed ? 'space-y-1.5 text-sm' : 'grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs',
      )}
    >
      {rows.map(({ label, value }, index) => (
        <div
          key={label}
          className={cn(
            'flex flex-wrap items-baseline gap-y-1',
            detailed ? 'justify-between gap-x-3' : 'gap-x-1.5',
            !detailed && index === 4 && 'col-span-2',
            !detailed && index >= 2 && 'text-text-secondary',
          )}
        >
          <dt className="text-text-secondary min-w-0 break-words">{label}</dt>
          <dd className="font-medium whitespace-nowrap">
            {formatTokens(normalizeTokenCount(value))}
          </dd>
        </div>
      ))}
    </dl>
  );

  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="border-border-light rounded-theme-menu-panel min-w-0 border p-3"
    >
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <h3 aria-labelledby={headingId}>
          <CollapsibleTrigger
            disabled={usage == null}
            className="group flex w-full items-start justify-between text-start"
          >
            <span className="min-w-0">
              <span
                id={headingId}
                className="text-text-primary block text-sm font-medium break-words"
              >
                {title}
              </span>
              {subtitle != null && (
                <span className="text-text-secondary block text-xs">{subtitle}</span>
              )}
            </span>
            <span className="ms-3 flex shrink-0 items-center gap-2">
              {cost != null && Number.isFinite(cost) && (
                <span
                  className="text-text-primary text-sm font-medium tabular-nums"
                  data-testid="usage-cost"
                >
                  <span className="sr-only">{costLabel}: </span>
                  {formatCost(cost, currency)}
                </span>
              )}
              {usage != null && (
                <ChevronDown
                  aria-hidden="true"
                  className="text-text-secondary size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
              )}
            </span>
          </CollapsibleTrigger>
        </h3>
        {usage == null ? (
          <p className="text-text-secondary mt-2 text-xs">{unavailable}</p>
        ) : (
          <>
            {!expanded && <div className="mt-2">{reading(false)}</div>}
            <CollapsibleContent className="mt-2">{reading(true)}</CollapsibleContent>
          </>
        )}
      </Collapsible>
    </section>
  );
}
