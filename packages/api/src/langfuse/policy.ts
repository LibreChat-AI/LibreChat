import { isForcedTemporaryRetention } from 'librechat-data-provider';
import type { TStartupConfig, TLangfuseUnavailableReason } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { isFalseEnv, isTrueEnv } from './utils';
import { normalizeString } from '~/utils/text';

const DEFAULT_SAMPLE_RATE = 1;
const MAX_TRACE_ID_ACCUMULATION = 0xffffffff;

export function isLangfuseTenantExportEnabled(): boolean {
  return !isTrueEnv(process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED);
}

export function isLangfuseCentralMediaUploadDisabled(): boolean {
  return isTrueEnv(process.env.LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED);
}

export function isLangfuseFanoutEnabled(): boolean {
  return (
    isTrueEnv(process.env.LANGFUSE_FANOUT_ENABLED) &&
    normalizeString(process.env.LANGFUSE_FANOUT_COLLECTOR_URL) != null
  );
}

export function hasLangfuseEnvCredentials(): boolean {
  return (
    normalizeString(process.env.LANGFUSE_PUBLIC_KEY) != null &&
    normalizeString(process.env.LANGFUSE_SECRET_KEY) != null
  );
}

export function usesLangfuseMultiTenantRouting(): boolean {
  return process.env.TENANT_ISOLATION_STRICT === 'true' || isLangfuseFanoutEnabled();
}

export function getLangfuseSampleRate(): number {
  const value = normalizeString(process.env.LANGFUSE_SAMPLE_RATE);
  if (value == null) {
    return DEFAULT_SAMPLE_RATE;
  }

  const sampleRate = Number(value);
  if (!Number.isFinite(sampleRate)) {
    return DEFAULT_SAMPLE_RATE;
  }
  return Math.min(1, Math.max(0, sampleRate));
}

export function isLangfuseTracingEnabled(): boolean {
  return !isFalseEnv(process.env.LANGFUSE_TRACING_ENABLED) && getLangfuseSampleRate() > 0;
}

function traceIdAccumulation(traceId: string): number {
  // Match OpenTelemetry's TraceIdRatioBasedSampler so one trace has one stable
  // sampling decision across trace export and later feedback scores.
  let accumulation = 0;
  for (let offset = 0; offset < 32; offset += 8) {
    const part = Number.parseInt(traceId.slice(offset, offset + 8), 16);
    accumulation = (accumulation ^ part) >>> 0;
  }
  return accumulation;
}

/**
 * A temporary chat reaches no Langfuse destination unless the deployment opts
 * in. `interface.retentionMode: "ephemeral"` makes every chat temporary, so it
 * counts even when the caller only knows a row's stored flag. Read strictly,
 * since admin config patches persist without validation.
 */
export function isLangfuseTraceAllowed(
  appConfig: AppConfig | undefined,
  isTemporary?: boolean | null,
): boolean {
  if (appConfig?.langfuse?.trace?.temporaryChats === true) {
    return true;
  }
  return (
    isTemporary !== true && !isForcedTemporaryRetention(appConfig?.interfaceConfig?.retentionMode)
  );
}

export function isLangfuseTraceSampled(traceId: string): boolean {
  if (!isLangfuseTracingEnabled()) {
    return false;
  }

  const sampleRate = getLangfuseSampleRate();
  if (sampleRate >= 1) {
    return true;
  }
  if (!/^[0-9a-f]{32}$/i.test(traceId)) {
    return false;
  }

  return traceIdAccumulation(traceId) < Math.floor(sampleRate * MAX_TRACE_ID_ACCUMULATION);
}

const DEFAULT_PROMPT_SYNC_TIMEOUT_MS = 10_000;
const MIN_PROMPT_SYNC_TIMEOUT_MS = 1_000;
const MAX_PROMPT_SYNC_TIMEOUT_MS = 60_000;

export function isLangfusePromptSyncAvailable(): boolean {
  return isTrueEnv(process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE);
}

export function getLangfusePromptSyncTimeoutMs(): number {
  const value = normalizeString(process.env.LANGFUSE_PROMPT_SYNC_TIMEOUT_MS);
  if (value == null) {
    return DEFAULT_PROMPT_SYNC_TIMEOUT_MS;
  }

  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_PROMPT_SYNC_TIMEOUT_MS;
  }
  return Math.round(
    Math.min(MAX_PROMPT_SYNC_TIMEOUT_MS, Math.max(MIN_PROMPT_SYNC_TIMEOUT_MS, timeoutMs)),
  );
}

const DEFAULT_PROMPT_SYNC_LOCK_LEASE_MS = 300_000;
const MIN_PROMPT_SYNC_LOCK_LEASE_MS = 60_000;
const MAX_PROMPT_SYNC_LOCK_LEASE_MS = 3_600_000;

/** Prompt sync lock lease, in milliseconds. Configured on librechat.yaml's
 *  langfuse.promptSync.lockLeaseMs; clamps to the supported range and falls
 *  back to the default when unset. */
export function getLangfusePromptSyncLockLeaseMs(appConfig: AppConfig | undefined): number {
  const leaseMs = appConfig?.langfuse?.promptSync?.lockLeaseMs;
  if (leaseMs == null) {
    return DEFAULT_PROMPT_SYNC_LOCK_LEASE_MS;
  }
  return Math.round(
    Math.min(MAX_PROMPT_SYNC_LOCK_LEASE_MS, Math.max(MIN_PROMPT_SYNC_LOCK_LEASE_MS, leaseMs)),
  );
}

const DEFAULT_PROMPT_SYNC_MAX_PAGES = 50;
const MIN_PROMPT_SYNC_MAX_PAGES = 1;
const MAX_PROMPT_SYNC_MAX_PAGES = 1000;

/** Page cap for one sync request, in pages of up to 100 Langfuse prompts
 *  each. Configured on librechat.yaml's langfuse.promptSync.maxPages;
 *  clamps to the supported range and falls back to the default when unset. */
export function getLangfusePromptSyncMaxPages(appConfig: AppConfig | undefined): number {
  const maxPages = appConfig?.langfuse?.promptSync?.maxPages;
  if (maxPages == null) {
    return DEFAULT_PROMPT_SYNC_MAX_PAGES;
  }
  return Math.round(
    Math.min(MAX_PROMPT_SYNC_MAX_PAGES, Math.max(MIN_PROMPT_SYNC_MAX_PAGES, maxPages)),
  );
}

/** Whether the deployment offers Langfuse connection settings, and if not, why. */
export type LangfuseConnectionAvailability =
  | { available: true }
  | { available: false; reason: TLangfuseUnavailableReason };

/**
 * Whether admins can store a Langfuse connection: tracing is on, and either traces route per
 * tenant through a fanout collector that exports to tenants' projects, or a single-tenant
 * deployment has no Langfuse credentials in its environment (which would take the connection's
 * place). Otherwise the reason names the setting that stops it.
 */
export function getLangfuseConnectionAvailability(): LangfuseConnectionAvailability {
  if (!isLangfuseTracingEnabled()) {
    return { available: false, reason: 'tracing_disabled' };
  }
  if (usesLangfuseMultiTenantRouting()) {
    if (!isLangfuseFanoutEnabled()) {
      return { available: false, reason: 'fanout_disabled' };
    }
    if (!isLangfuseTenantExportEnabled()) {
      return { available: false, reason: 'tenant_export_disabled' };
    }
    return { available: true };
  }
  if (hasLangfuseEnvCredentials()) {
    return { available: false, reason: 'env_credentials' };
  }
  return { available: true };
}

export function isLangfuseConnectionAvailable(): boolean {
  return getLangfuseConnectionAvailability().available;
}

/** Settings remain available for prompt reads when trace connection editing is disabled. */
export function isLangfuseSettingsAvailable(): boolean {
  return isLangfuseConnectionAvailable() || isLangfusePromptSyncAvailable();
}

/** One permission check supplies both settings gates. Trace links keep their connection gate. */
export function getLangfuseSettingsAccess(
  canManage: boolean,
): Pick<TStartupConfig, 'langfuseConnectionAccess' | 'langfusePromptSyncAccess'> {
  return {
    langfuseConnectionAccess: canManage && isLangfuseConnectionAvailable(),
    langfusePromptSyncAccess: canManage && isLangfusePromptSyncAvailable(),
  };
}
