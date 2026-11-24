import { useContext, useId, useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { ChevronRight } from 'lucide-react';
import { useExpandCollapse } from '@librechat/chat/components';
import { formatNumber, resolveErrorIdentity, resolveErrorEndpoint } from '@librechat/chat';
import type { ErrorEndpoint, ErrorPayload } from '@librechat/chat';
import type { ErrorSource } from './source';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useTranscriptAgentsMap } from '~/hooks/Agents/useTranscriptAgent';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { ChatContext } from '~/Providers/ChatContext';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export {
  readString,
  readNumber,
  readObject,
  formatNumber,
  formatDuration,
  formatTimestamp,
  getProviderName,
  ProviderErrorCodes,
} from '@librechat/chat';
export type { JsonValue, ErrorPayload, ErrorEndpoint } from '@librechat/chat';

export type ErrorRendererProps = {
  /** The payload parsed out of the message text. */
  json: ErrorPayload;
  /** The message text as persisted, including any prefix around the payload. */
  text: string;
  /** The row this error belongs to; absent only where no row supplies an `ErrorSource`. */
  message?: ErrorSource;
};

/** The fallback renderer also runs when there is no payload at all. */
export type UnclassifiedErrorProps = Omit<ErrorRendererProps, 'json'> & { json?: ErrorPayload };

/**
 * Resolves who produced the failure, from the row and what the chat knows.
 *
 * Error content renders in the chat, in search results and in shared links. Only the chat surface
 * mounts `ChatContext`, and a shared link is read by a viewer whose query client is not
 * authenticated, so the endpoint queries stay disabled outside the chat rather than firing a
 * request that would resolve to a login redirect.
 */
export function useErrorEndpoint(source?: ErrorSource, payloadEndpoint?: string): ErrorEndpoint {
  const chat = useContext(ChatContext);
  const savedAgents = useAgentsMapContext();
  const inChat = chat != null;
  const { data: endpointsConfig } = useGetEndpointsQuery({ enabled: inChat });
  const { data: startupConfig } = useGetStartupConfig({ enabled: inChat });
  const conversation = chat?.conversation;
  const { agentKey } = resolveErrorIdentity(source, conversation);
  const agentsMap = useTranscriptAgentsMap(agentKey);
  const compactionEnabled =
    inChat &&
    startupConfig?.compactionEnabled === true &&
    startupConfig.interface?.contextUsage !== false;

  return useMemo(
    () =>
      resolveErrorEndpoint(source, payloadEndpoint, {
        conversation,
        agentsMap,
        savedAgents,
        endpointsConfig,
        compactionEnabled,
      }),
    [
      source,
      payloadEndpoint,
      conversation,
      agentsMap,
      savedAgents,
      endpointsConfig,
      compactionEnabled,
    ],
  );
}

/** Stacks an error's sentences, details and actions without inheriting prose spacing. */
export function ErrorBody({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}

/**
 * Secondary information a reader only wants after the headline: a provider's own message, a token
 * budget, a generation breakdown. Collapsed by default and rendered as text rather than through
 * `CodeBlock`, which frames a detail in a code bar and a dark slab that reads as output.
 *
 * Motion is `useExpandCollapse`, the same `grid-template-rows` tween the tool rows and activity
 * phases in the transcript use, so a detail inside an error box opens on the curve the rest of the
 * message content already moves on (and inherits its reduced-motion and `inert` handling).
 *
 * The body stays mounted while collapsed. That is what makes the card resize rather than jump: a
 * collapsed row still contributes its width to the box's intrinsic size, so the box only ever
 * changes height, and it changes it on the tween instead of in one step. The gap to the trigger
 * lives inside the animated element for the same reason — as a margin outside it, it would appear
 * in a single step once the height reached zero.
 */
export function ErrorDetails({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { style: panelStyle, ref: panelRef } = useExpandCollapse(open);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((expanded) => !expanded)}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-text-secondary hover:text-text-primary focus-visible:ring-text-primary flex items-center gap-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
      >
        {label}
        <ChevronRight
          className={cn(
            'size-3.5 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            open ? 'rotate-90' : 'rtl:-scale-x-100',
          )}
          aria-hidden="true"
        />
      </button>
      <div id={panelId} style={panelStyle} aria-hidden={!open}>
        <div ref={panelRef} className="overflow-hidden">
          <div className="text-text-secondary mt-1 text-xs break-words whitespace-pre-wrap">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Past a sentence's worth of text, or across lines, a detail is a body to open rather than read. */
const INLINE_DETAIL_LENGTH = 240;

/**
 * A headline plus the failure's own words, the way every provider-produced error reads: what is
 * known first, the reported text second. A single sentence stays in place, where a reader gets it
 * without acting; a body of text collapses under `label` unless `inline` says the detail is the
 * instruction the reader needs, as a gateway's explanation of a spent budget is.
 */
export function ErrorWithDetail({
  headline,
  detail,
  label,
  inline = false,
}: {
  headline: string;
  detail?: string;
  label: string;
  inline?: boolean;
}) {
  if (detail == null) {
    return <>{headline}</>;
  }

  return (
    <ErrorBody>
      <div>{headline}</div>
      {inline || (detail.length <= INLINE_DETAIL_LENGTH && !/[\r\n]/.test(detail)) ? (
        <div className="text-text-secondary break-words whitespace-pre-wrap">{detail}</div>
      ) : (
        <ErrorDetails label={label}>{detail}</ErrorDetails>
      )}
    </ErrorBody>
  );
}

export function ErrorActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** The one thing a reader can do about the failure, next to the sentence explaining it. */
export function ErrorAction({
  onClick,
  children,
  variant,
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  /** A second action next to the primary one reads as the alternative, not a peer. */
  variant?: 'outline';
  disabled?: boolean;
}) {
  return (
    /** One step tighter than the button default (8px) so the control reads as nested inside the
     *  error card's 12px corner rather than echoing it. */
    <Button
      type="button"
      size="sm"
      variant={variant}
      className="rounded-md"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

/** "minute" or "45 minutes", for limit copy that ends in "per …". */
export function useWindowLabel(windowInMinutes?: number): string | undefined {
  const localize = useLocalize();
  if (windowInMinutes == null) {
    return undefined;
  }
  return windowInMinutes === 1
    ? localize('com_error_window_minute')
    : localize('com_error_window_minutes', { 0: formatNumber(windowInMinutes) });
}
