import { useContext, useId, useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { ChevronRight } from 'lucide-react';
import {
  Constants,
  alternateName,
  getEndpointField,
  isAgentsEndpoint,
  isEphemeralAgentId,
  stripAgentIdSuffix,
  parseEphemeralAgentId,
} from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TAgentsMap,
  EModelEndpoint,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { ErrorSource } from './source';
import { isUserProvidedEndpointConfig } from '~/components/Nav/SettingsTabs/ProviderKeys/utils';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { supportsCompaction } from '~/hooks/Chat/useCompactConversation';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useExpandCollapse, useLocalize } from '~/hooks';
import { ChatContext } from '~/Providers/ChatContext';
import { cn } from '~/utils';

/** A value as `JSON.parse` produces it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | ErrorPayload;

/** A parsed error payload. Producers are free-form, so every field is read defensively. */
export type ErrorPayload = { [key: string]: JsonValue | undefined };

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
 * Provider error codes that are not LibreChat's own. They reach the client when a provider's error
 * body is persisted as the message text, which is also why they are plain strings rather than
 * `ErrorTypes` members.
 */
export const ProviderErrorCodes = {
  INVALID_API_KEY: 'invalid_api_key',
  INSUFFICIENT_QUOTA: 'insufficient_quota',
} as const;

export function readString(json: ErrorPayload | undefined, key: string): string | undefined {
  const value = json?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNumber(json: ErrorPayload | undefined, key: string): number | undefined {
  const value = json?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  /** Limiter payloads cross the wire as JSON, but a stored `max` may be a numeric string. */
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function readObject(json: ErrorPayload | undefined, key: string): ErrorPayload | undefined {
  const value = json?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** The name a reader recognizes for an endpoint id. */
export const getProviderName = (endpoint: string): string =>
  (alternateName[endpoint] as string | undefined) ?? endpoint;

export type ErrorEndpoint = {
  /** The endpoint the failed request ran against, when it is knowable. */
  endpoint?: string;
  endpointType?: EModelEndpoint;
  /** Display name for the provider; undefined when the endpoint cannot be resolved. */
  provider?: string;
  /** The model that produced the failure. */
  model?: string;
  /** The saved agent that produced the failure, when the agents map can resolve it. */
  agent?: Agent;
  /**
   * The reader, not the deployment, maintains the endpoint's credentials (key, URL or both).
   * Undefined where no endpoint configuration is available to this viewer, as on a shared link.
   */
  userProvidesCredentials?: boolean;
  /**
   * Manual context compaction can be triggered for this conversation. It is only offered from the
   * chat composer's context usage popover, so neither a surface outside the chat (search, a shared
   * link) nor a deployment that hides that indicator has compaction to suggest.
   */
  compactionAvailable: boolean;
  endpointsConfig?: TEndpointsConfig;
};

/** What an agent ran against: its provider (an endpoint id) and model, and the saved agent if any. */
type AgentIdentity = { agent?: Agent; endpoint?: string; model?: string };

/**
 * Resolves an agent id the way the transcript's sibling headers do: a saved agent through the
 * agents map (without the `____N` suffix parallel runs append), an ephemeral agent through the
 * endpoint and model its id encodes.
 */
function resolveAgentId(agentsMap: TAgentsMap | undefined, agentId: string): AgentIdentity {
  const agent = agentsMap?.[stripAgentIdSuffix(agentId)];
  if (agent != null) {
    return { agent, endpoint: agent.provider || undefined, model: agent.model ?? undefined };
  }
  const ephemeral = isEphemeralAgentId(agentId) ? parseEphemeralAgentId(agentId) : undefined;
  return ephemeral == null ? {} : { endpoint: ephemeral.endpoint, model: ephemeral.model };
}

/**
 * Who ran the failing part of an agents row. The part's own agent (its parallel lane's, or the one
 * a handoff made active) comes first. Otherwise the row's `model` says: a saved agent's rows,
 * including the live placeholder the client builds, store the agent id there, and an ephemeral
 * agent's store its encoded id or the model itself. The conversation's agent is read only for an
 * error with no row at all. An id that resolves to nothing names nothing, so neither an agent id
 * nor a placeholder is ever shown as a model, while a plain model name is kept.
 */
function resolveAgentRow(
  agentsMap: TAgentsMap | undefined,
  {
    partAgentId,
    rowModel,
    conversationAgentId,
  }: { partAgentId?: string; rowModel?: string; conversationAgentId?: string },
): AgentIdentity {
  const agentId = partAgentId ?? conversationAgentId;
  if (agentId != null) {
    return resolveAgentId(agentsMap, agentId);
  }
  if (rowModel == null || rowModel === Constants.EPHEMERAL_AGENT_ID) {
    return {};
  }
  const resolved = resolveAgentId(agentsMap, rowModel);
  if (resolved.endpoint != null || !isEphemeralAgentId(rowModel)) {
    return resolved;
  }
  return { model: rowModel };
}

/**
 * Whether the reader maintains an endpoint's credentials. A user-provided base URL counts even with
 * a deployment key: the server then reads both the key and the URL from the reader's own record,
 * so the key dialog, which edits both, is the fix for its failures too.
 */
const readerOwnsCredentials = (config?: TConfig | null): boolean =>
  isUserProvidedEndpointConfig(config) || config?.userProvideURL === true;

/** Without a loaded endpoint configuration, ownership is unknown rather than the deployment's. */
function resolveCredentialOwnership(
  endpointsConfig: TEndpointsConfig | undefined,
  endpoint: string | undefined,
): boolean | undefined {
  if (endpoint == null) {
    return false;
  }
  return endpointsConfig == null ? undefined : readerOwnsCredentials(endpointsConfig[endpoint]);
}

/**
 * Resolves who produced the failure.
 *
 * Error content renders in the chat, in search results and in shared links. Only the chat surface
 * mounts `ChatContext`, and a shared link is read by a viewer whose query client is not
 * authenticated, so the endpoint queries stay disabled outside the chat rather than firing a
 * request that would resolve to a login redirect. Copy therefore has to work without a provider
 * name, which is why `provider` and `model` are optional.
 *
 * A saved agent's row names the `agents` endpoint and carries the agent id as its model, while the
 * request ran against the agent's own provider and model, so those are what identity, key
 * ownership and the key dialog resolve against; after a handoff, that is the agent the handoff
 * made active, and in a parallel run, the agent of the error's own lane. An endpoint named by the
 * payload itself outranks all of them. Compaction is a
 * conversation action, so it stays keyed to the row's endpoint.
 */
export function useErrorEndpoint(source?: ErrorSource, payloadEndpoint?: string): ErrorEndpoint {
  const chat = useContext(ChatContext);
  const agentsMap = useAgentsMapContext();
  const inChat = chat != null;
  const { data: endpointsConfig } = useGetEndpointsQuery({ enabled: inChat });
  const { data: startupConfig } = useGetStartupConfig({ enabled: inChat });

  /**
   * A row's own identity is authoritative even where it lacks a field: borrowing the conversation's
   * current selection, or its current agent, would attribute an old failure to whatever the reader
   * picked since. Only an error rendered with no row at all reads the conversation.
   */
  const identity = source ?? chat?.conversation ?? undefined;
  const rowEndpoint = identity?.endpoint ?? undefined;
  const rowModel = identity?.model ?? undefined;
  const conversationAgentId =
    source == null && chat?.conversation?.agent_id !== Constants.EPHEMERAL_AGENT_ID
      ? (chat?.conversation?.agent_id ?? undefined)
      : undefined;
  const partAgentId = source?.partAgentId;

  return useMemo(() => {
    const agentRow = partAgentId != null || isAgentsEndpoint(rowEndpoint);
    const agentIdentity = agentRow
      ? resolveAgentRow(agentsMap, { partAgentId, rowModel, conversationAgentId })
      : undefined;
    const rowProvider = agentRow ? agentIdentity?.endpoint : rowEndpoint;
    const endpoint = payloadEndpoint ?? rowProvider;
    const endpointType = endpoint
      ? (getEndpointField(endpointsConfig, endpoint, 'type') as EModelEndpoint | undefined)
      : undefined;
    return {
      endpoint,
      endpointType,
      provider: endpoint ? getProviderName(endpoint) : undefined,
      model: agentRow ? agentIdentity?.model : rowModel,
      agent: agentIdentity?.agent,
      userProvidesCredentials: resolveCredentialOwnership(endpointsConfig, endpoint),
      compactionAvailable:
        inChat &&
        startupConfig?.compactionEnabled === true &&
        startupConfig.interface?.contextUsage !== false &&
        supportsCompaction(rowEndpoint),
      endpointsConfig,
    };
  }, [
    inChat,
    rowEndpoint,
    rowModel,
    conversationAgentId,
    partAgentId,
    payloadEndpoint,
    agentsMap,
    endpointsConfig,
    startupConfig?.compactionEnabled,
    startupConfig?.interface?.contextUsage,
  ]);
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
        className="flex items-center gap-1 rounded-md text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
      >
        {label}
        <ChevronRight
          className={cn(
            'size-3.5 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      <div id={panelId} style={panelStyle} aria-hidden={!open}>
        <div ref={panelRef} className="overflow-hidden">
          <div className="mt-1 whitespace-pre-wrap break-words text-xs text-text-secondary">
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
 * without acting; a body of text collapses under `label`.
 */
export function ErrorWithDetail({
  headline,
  detail,
  label,
}: {
  headline: string;
  detail?: string;
  label: string;
}) {
  if (detail == null) {
    return <>{headline}</>;
  }

  return (
    <ErrorBody>
      <div>{headline}</div>
      {detail.length <= INLINE_DETAIL_LENGTH && !/[\r\n]/.test(detail) ? (
        <div className="text-text-secondary">{detail}</div>
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
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    /** One step tighter than the button default (8px) so the control reads as nested inside the
     *  error card's 12px corner rather than echoing it. */
    <Button type="button" size="sm" className="rounded-md" onClick={onClick}>
      {children}
    </Button>
  );
}

export const formatNumber = (value: number): string => new Intl.NumberFormat().format(value);

/** Token credits are a float balance; two decimals, matching the balance settings row. */
export const formatCredits = (value: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Formats a stored timestamp in the reader's locale. Only epoch milliseconds and ISO 8601 strings
 * are parsed: rows persisted by older servers carry an expiry in the server's own locale format,
 * which another locale can misread (a day-first date read month-first), so any other string is
 * shown as persisted.
 */
export function formatTimestamp(value: string | number): string {
  if (typeof value === 'string' && !isoTimestamp.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

/** `m:ss`, or `h:mm:ss` past an hour — the shape a countdown is read in. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
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
