import { isIP } from 'node:net';
import { configCapability, SystemCapabilities } from '@librechat/data-schemas';
import type {
  ChannelRunSummary,
  ChannelRunSnapshot,
  ChannelSummaryMetric,
  AccountingBasis,
  TCustomConfig,
} from 'librechat-data-provider';
import type {
  ChannelRunRecord,
  ChannelSummaryRow,
  ChannelSummaryStorage,
} from '@librechat/data-schemas';
import type { CapabilityUser, GetHeldCapabilitiesFn } from '~/middleware/capabilities';
import type { LangfuseSessionLinkParams } from '~/langfuse/session';
import type { LangfuseSession } from '~/langfuse/session';
import type { ChannelMessage } from './types';
import { resolveLangfuseSession } from '~/langfuse/session';

export interface ChannelSummaryTraceDependencies {
  /** Current principal/tenant capabilities, using the existing trace UI authorization policy. */
  canViewSession: (run: ChannelRunRecord) => Promise<boolean>;
  getMessage: (scope: {
    tenantId: string;
    user: string;
    conversationId: string;
    messageId: string;
  }) => Promise<ChannelMessage | null>;
  /** Existing configured/trusted UI destination resolver. Never infer a UI from an export endpoint. */
  resolveSession: (run: ChannelRunRecord) => Promise<LangfuseSession | null>;
}

export interface ChannelSummaryDependencies {
  storage: ChannelSummaryStorage;
  trace?: ChannelSummaryTraceDependencies;
}

export interface ChannelSummaryTraceResolverDependencies {
  findUser: (userId: string) => Promise<{
    id?: string;
    _id?: { toString(): string };
    role?: string | null;
    tenantId?: string | null;
    idOnTheSource?: string | null;
  } | null>;
  getHeldCapabilities: GetHeldCapabilitiesFn;
  getConfig: (run: ChannelRunRecord) => Promise<TCustomConfig['langfuse']>;
  getMessage: ChannelSummaryTraceDependencies['getMessage'];
  getMessages: LangfuseSessionLinkParams['getMessages'];
}

/** Same current-tenant capability policy as shared-link trace UI, with the configured session resolver. */
export function createChannelSummaryTraceResolver(
  deps: ChannelSummaryTraceResolverDependencies,
): ChannelSummaryTraceDependencies {
  return {
    async canViewSession(run) {
      const source = await deps.findUser(run.principal.userId);
      const id = source?.id ?? source?._id?.toString();
      if (!source || id !== run.principal.userId || (source.tenantId ?? '_') !== run.tenantId)
        return false;
      const user: CapabilityUser = {
        id,
        role: source.role ?? '',
        tenantId: source.tenantId ?? undefined,
        idOnTheSource: source.idOnTheSource ?? null,
      };
      const langfuse = configCapability('langfuse');
      const held = await deps.getHeldCapabilities(user, [
        SystemCapabilities.ACCESS_ADMIN,
        SystemCapabilities.MANAGE_CONFIGS,
        langfuse,
      ]);
      return (
        held.has(SystemCapabilities.ACCESS_ADMIN) &&
        (held.has(SystemCapabilities.MANAGE_CONFIGS) || held.has(langfuse))
      );
    },
    getMessage: deps.getMessage,
    async resolveSession(run) {
      if (!run.execution?.conversationId) return null;
      return resolveLangfuseSession({
        config: await deps.getConfig(run),
        conversationId: run.execution.conversationId,
        userId: run.principal.userId,
        getMessages: deps.getMessages,
      });
    },
  };
}

function safeCount(value: number | undefined): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0;
}

function metric<T>(coveredRuns: number, expectedRuns: number, value: T): ChannelSummaryMetric<T> {
  if (!coveredRuns) return { coverage: 'unavailable', coveredRuns };
  if (coveredRuns === expectedRuns) return { coverage: 'complete', coveredRuns, value };
  return { coverage: 'partial', coveredRuns, knownValue: value };
}

function amountUnits(amount: string | undefined): bigint | null {
  if (!amount || amount.length > 64 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}

function amountString(units: bigint): string {
  const digits = units.toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return digits.slice(0, -18) + (fraction ? `.${fraction}` : '');
}

async function session(
  deps: ChannelSummaryTraceDependencies | undefined,
  run: ChannelRunRecord,
  snapshot: ChannelRunSnapshot,
): Promise<ChannelRunSummary['session']> {
  if (!deps || !snapshot.responseId || !run.execution?.conversationId) return undefined;
  if (!(await deps.canViewSession(run))) return undefined;
  const message = await deps.getMessage({
    tenantId: run.tenantId,
    user: run.principal.userId,
    conversationId: run.execution.conversationId,
    messageId: snapshot.responseId,
  });
  if (
    !message ||
    message.user !== run.principal.userId ||
    (message.tenantId ?? '_') !== run.tenantId ||
    message.conversationId !== run.execution.conversationId ||
    message.messageId !== snapshot.responseId ||
    message.isCreatedByUser !== false ||
    message.langfuseSampled !== true ||
    !message.langfuseDestinationIds?.length
  )
    return undefined;
  const resolved = await deps.resolveSession(run);
  if (!resolved || !message.langfuseDestinationIds.includes(resolved.destinationId))
    return undefined;
  const url = new URL(resolved.url);
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    url.protocol !== 'https:' ||
    isIP(hostname) !== 0 ||
    !hostname.includes('.') ||
    /\.(?:localhost|local|localdomain|internal|lan|home|test|invalid|example)$/.test(hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  return { url: url.toString() };
}

/** Footer metadata only. The caller checks live authority before and after, then freezes the snapshot. */
export function createChannelSummaryService(deps: ChannelSummaryDependencies): {
  summarize(run: ChannelRunRecord, snapshot: ChannelRunSnapshot): Promise<ChannelRunSummary>;
} {
  return {
    async summarize(run, snapshot) {
      if (run.snapshot?.summary) return run.snapshot.summary;
      if (!Number.isSafeInteger(run.sequence) || run.sequence < 1)
        throw new Error('Invalid channel summary sequence');
      let observedRuns = 0;
      let elapsedRuns = 0;
      let elapsedMs = 0;
      let tokenRuns = 0;
      const tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let costRuns = 0;
      let costUnits = BigInt(0);
      let basis: AccountingBasis | undefined;
      let mixedBases = false;
      const consume = (row: ChannelSummaryRow): void => {
        observedRuns++;
        const value = row.snapshot;
        if (!value || !['completed', 'failed', 'cancelled'].includes(value.status)) return;
        if (safeCount(value.elapsedMs)) {
          elapsedMs += value.elapsedMs;
          elapsedRuns++;
        }
        const usage = value.usage;
        const accounting = value.accounting;
        if (
          usage &&
          safeCount(usage.inputTokens) &&
          safeCount(usage.outputTokens) &&
          safeCount(usage.totalTokens) &&
          usage.totalTokens === usage.inputTokens + usage.outputTokens &&
          accounting?.reason !== 'usage_unavailable' &&
          accounting?.reason !== 'conflicting_usage' &&
          !accounting?.calls?.some(
            (call) => call.reason === 'invalid_usage' || call.reason === 'usage_unavailable',
          )
        ) {
          tokens.inputTokens += usage.inputTokens;
          tokens.outputTokens += usage.outputTokens;
          tokens.totalTokens += usage.totalTokens;
          tokenRuns++;
        }
        const units = amountUnits(accounting?.amount);
        if (
          accounting?.status === 'available' &&
          accounting.coverage === 'complete' &&
          accounting.reason === 'priced' &&
          accounting.currency === 'USD' &&
          units != null &&
          (accounting.basis === 'provider_reported' || accounting.basis === 'application_billing')
        ) {
          mixedBases ||= basis != null && basis !== accounting.basis;
          basis ??= accounting.basis;
          costUnits += units;
          costRuns++;
        }
      };
      for await (const row of deps.storage.priorMetrics(run)) consume(row);
      consume({ sequence: run.sequence, snapshot });
      const summary: ChannelRunSummary = {
        version: 1,
        scope: 'actor_lane',
        throughSequence: run.sequence,
        includesCurrent: true,
        priorRuns: observedRuns - 1,
        expectedRuns: run.sequence,
        observedRuns,
        costUSD: mixedBases
          ? { coverage: 'unavailable', coveredRuns: 0 }
          : {
              ...metric(costRuns, run.sequence, amountString(costUnits)),
              ...(basis ? { basis } : {}),
            },
        elapsedMs: metric(safeCount(elapsedMs) ? elapsedRuns : 0, run.sequence, elapsedMs),
        tokens: metric(safeCount(tokens.totalTokens) ? tokenRuns : 0, run.sequence, tokens),
      };
      // Optional diagnostics must not withhold an otherwise valid answer or broaden trace access.
      try {
        const link = await session(deps.trace, run, snapshot);
        if (link) summary.session = link;
      } catch {
        // Unavailable policy/config/message lookup means no session link.
      }
      return summary;
    },
  };
}
