import type { AppConfig } from '@librechat/data-schemas';
import type { RunConfig } from '@librechat/agents';
import type { LangfuseTraceContext, LangfuseTraceUser } from './identity';
import {
  hasLangfuseEnvCredentials,
  isLangfuseCentralMediaUploadDisabled,
  isLangfuseFanoutEnabled,
  isLangfuseTenantExportEnabled,
  isLangfuseTraceSampled,
  isLangfuseTracingEnabled,
  usesLangfuseMultiTenantRouting,
} from './policy';
import { normalizeBoolean, resolveLangfuseHeaders, resolveTenantCredentials } from './utils';
import { buildLangfuseTraceMetadata, resolveLangfuseTraceUserId } from './identity';
import { resolveLangfuseTenantDestination } from './tenantDestinations';
import { scopeHeadersToDestination } from './destinations';
import { normalizeString } from '~/utils/text';
import { traceIdForMessage } from './trace';

type LangfuseRunConfig = NonNullable<RunConfig['langfuse']>;
type LangfuseRunConfigWithTraceAttributes = LangfuseRunConfig & {
  librechatTraceAttributes?: Record<string, string | number | boolean | null | undefined>;
  mediaUploadEnabled?: boolean;
  additionalHeaders?: Record<string, string>;
};
type LangfuseTenantDestination = NonNullable<ReturnType<typeof resolveLangfuseTenantDestination>>;
type TenantExportBlockReason =
  | 'collector_unconfigured'
  | 'destination_unconfigured'
  | 'emergency_disabled'
  | 'fanout_disabled'
  | 'missing_credentials'
  | 'tenant_disabled';
type LangfuseExportPlan =
  | { type: 'directCentral'; reason: 'collector_unconfigured' | 'fanout_disabled' }
  | { type: 'disabled'; reason: TenantExportBlockReason }
  | { type: 'fanoutCollector'; collectorUrl: string; reason: TenantExportBlockReason }
  | {
      type: 'tenantFanout';
      collectorUrl: string;
      destination: LangfuseTenantDestination;
      publicKey: string;
      secretKey: string;
    };
const TENANT_EXPORT_ATTRIBUTE = 'librechat.langfuse.tenant_export.enabled';
const TENANT_DESTINATION_ATTRIBUTE = 'librechat.langfuse.destination';
const CENTRAL_EXPORT_ATTRIBUTE = 'librechat.langfuse.central_export.enabled';
const EXPORT_PLAN_ATTRIBUTE = 'librechat.langfuse.export_plan';
const EXPORT_REASON_ATTRIBUTE = 'librechat.langfuse.export_reason';
const TENANT_ID_ATTRIBUTE = 'librechat.tenant.id';
const CENTRAL_MEDIA_DISABLED_SEGMENT = 'central-media-disabled';
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export { isLangfuseFanoutEnabled, isLangfuseTenantExportEnabled } from './policy';

function mergeTraceMetadata(
  base: LangfuseRunConfig['metadata'],
  tenantId?: string,
): LangfuseRunConfig['metadata'] | undefined {
  if (!tenantId) {
    return base;
  }
  return {
    ...(base ?? {}),
    'librechat.tenant.id': tenantId,
  };
}

function mergeTags(tags: string[] | undefined, tenantId?: string): string[] | undefined {
  if (!tenantId) {
    return tags;
  }
  return [...new Set([...(tags ?? []), `tenant:${tenantId}`])];
}

function applyCentralEnvConfig(langfuse: LangfuseRunConfigWithTraceAttributes): void {
  const publicKey = normalizeString(process.env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeString(process.env.LANGFUSE_SECRET_KEY);
  if (publicKey && secretKey) {
    langfuse.publicKey = publicKey;
    langfuse.secretKey = secretKey;
    langfuse.baseUrl =
      normalizeString(process.env.LANGFUSE_BASE_URL) ??
      normalizeString(process.env.LANGFUSE_HOST) ??
      normalizeString(process.env.LANGFUSE_BASEURL) ??
      DEFAULT_BASE_URL;
  }
}

/**
 * Attaches the deployment's headers only once the export branch has settled on
 * a `baseUrl`, and only when that origin is one the operator configured.
 *
 * A run resolves to a single destination, but which one depends on the branch —
 * attaching earlier would send a gateway credential to whatever endpoint the
 * config happened to fall through to, including Langfuse Cloud.
 */
function applyCustomHeaders(
  langfuse: LangfuseRunConfigWithTraceAttributes,
  additionalHeaders?: Record<string, string>,
): LangfuseRunConfigWithTraceAttributes {
  if (langfuse.enabled === false || langfuse.baseUrl == null) {
    return langfuse;
  }
  const scoped = scopeHeadersToDestination(additionalHeaders, langfuse.baseUrl);
  if (scoped) {
    langfuse.additionalHeaders = scoped;
  }
  return langfuse;
}

function disableCentralExport(langfuse: LangfuseRunConfigWithTraceAttributes): void {
  langfuse.librechatTraceAttributes = {
    ...(langfuse.librechatTraceAttributes ?? {}),
    [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
  };
}

function getTenantExportBlockReason({
  tenantLangfuseEnabled,
  hasTenantCredentials,
  tenantExportEmergencyEnabled,
  tenantDestination,
}: {
  tenantLangfuseEnabled: boolean;
  hasTenantCredentials: boolean;
  tenantExportEmergencyEnabled: boolean;
  tenantDestination?: LangfuseTenantDestination;
}): TenantExportBlockReason {
  if (!tenantLangfuseEnabled) {
    return 'tenant_disabled';
  }
  if (!hasTenantCredentials) {
    return 'missing_credentials';
  }
  if (!tenantExportEmergencyEnabled) {
    return 'emergency_disabled';
  }
  if (tenantDestination == null) {
    return 'destination_unconfigured';
  }
  return 'missing_credentials';
}

function applyExportPlanTelemetry(
  langfuse: LangfuseRunConfigWithTraceAttributes,
  exportPlan: LangfuseExportPlan,
  tenantId?: string,
): void {
  let exportPlanName = 'central_only';
  if (exportPlan.type === 'tenantFanout') {
    exportPlanName = 'tenant_fanout';
  } else if (exportPlan.type === 'disabled') {
    exportPlanName = 'disabled';
  }
  const exportReason = exportPlan.type === 'tenantFanout' ? 'configured' : exportPlan.reason;

  langfuse.librechatTraceAttributes = {
    ...(langfuse.librechatTraceAttributes ?? {}),
    ...(tenantId ? { [TENANT_ID_ATTRIBUTE]: tenantId } : {}),
    [EXPORT_PLAN_ATTRIBUTE]: exportPlanName,
    [EXPORT_REASON_ATTRIBUTE]: exportReason,
  };
}

function resolveLangfuseExportPlan({
  centralTraceExportEnabled,
  fanoutEnabled,
  fanoutRequested,
  fanoutCollectorUrl,
  tenantLangfuseEnabled,
  hasTenantCredentials,
  tenantExportEmergencyEnabled,
  publicKey,
  secretKey,
  tenantDestination,
}: {
  centralTraceExportEnabled: boolean;
  fanoutEnabled: boolean;
  fanoutRequested: boolean;
  fanoutCollectorUrl?: string;
  tenantLangfuseEnabled: boolean;
  hasTenantCredentials: boolean;
  tenantExportEmergencyEnabled: boolean;
  publicKey?: string;
  secretKey?: string;
  tenantDestination?: LangfuseTenantDestination;
}): LangfuseExportPlan {
  if (!fanoutEnabled || fanoutCollectorUrl == null) {
    const reason = fanoutRequested ? 'collector_unconfigured' : 'fanout_disabled';
    if (centralTraceExportEnabled) {
      return {
        type: 'directCentral',
        reason,
      };
    }
    return { type: 'disabled', reason };
  }

  const canRouteTenantFanout =
    tenantLangfuseEnabled &&
    hasTenantCredentials &&
    tenantExportEmergencyEnabled &&
    publicKey != null &&
    secretKey != null &&
    tenantDestination != null;

  if (canRouteTenantFanout) {
    return {
      type: 'tenantFanout',
      collectorUrl: fanoutCollectorUrl,
      destination: tenantDestination,
      publicKey,
      secretKey,
    };
  }

  // Direct central export can use the collector normally. Central-suppressed
  // runs only reach the collector through a concrete tenant fanout route.
  if (centralTraceExportEnabled) {
    return {
      type: 'fanoutCollector',
      collectorUrl: fanoutCollectorUrl,
      reason: getTenantExportBlockReason({
        tenantLangfuseEnabled,
        hasTenantCredentials,
        tenantExportEmergencyEnabled,
        tenantDestination,
      }),
    };
  }

  return {
    type: 'disabled',
    reason: getTenantExportBlockReason({
      tenantLangfuseEnabled,
      hasTenantCredentials,
      tenantExportEmergencyEnabled,
      tenantDestination,
    }),
  };
}

export function buildLangfuseConfig({
  appConfig,
  runId,
  tenantId,
  centralTraceExportEnabled = true,
  user,
  traceContext,
}: {
  appConfig?: AppConfig;
  runId?: string;
  tenantId?: string;
  /**
   * Defaults to true. Set false to suppress central Langfuse export for this
   * run. Fanout deployments stamp a routing attribute that the collector uses
   * to drop the central pipeline while preserving tenant fanout when available.
   */
  centralTraceExportEnabled?: boolean;
  /** The requesting user, read only for the fields `langfuse.trace` allowlists. */
  user?: LangfuseTraceUser;
  /** Request values `langfuse.trace.conversationMetadataFields` may export. */
  traceContext?: LangfuseTraceContext;
} = {}): LangfuseRunConfig {
  const normalizedTenantId = normalizeString(tenantId);
  const config = appConfig?.langfuse;

  const langfuse: LangfuseRunConfigWithTraceAttributes = {
    deterministicTraceId: true,
  };
  const traceUserId = resolveLangfuseTraceUserId(config?.trace, user);
  if (traceUserId != null) {
    langfuse.userId = traceUserId;
  }
  const metadata = mergeTraceMetadata(
    buildLangfuseTraceMetadata({ trace: config?.trace, user, context: traceContext }),
    normalizedTenantId,
  );
  const tags = mergeTags(undefined, normalizedTenantId);
  if (metadata) {
    langfuse.metadata = metadata;
  }
  if (tags) {
    langfuse.tags = tags;
  }

  if (
    !isLangfuseTracingEnabled() ||
    (runId != null && !isLangfuseTraceSampled(traceIdForMessage(runId)))
  ) {
    langfuse.enabled = false;
    return langfuse;
  }

  const additionalHeaders = resolveLangfuseHeaders(config?.headers);

  const tenantLangfuseEnabled = normalizeBoolean(config?.enabled) === true;
  if (!centralTraceExportEnabled) {
    disableCentralExport(langfuse);
  }

  const tenantCredentials = resolveTenantCredentials(config);
  const hasTenantCredentials = Boolean(tenantCredentials);
  const fanoutEnabled = isLangfuseFanoutEnabled();
  const fanoutRequested = normalizeBoolean(process.env.LANGFUSE_FANOUT_ENABLED) === true;
  const fanoutCollectorUrl = normalizeString(process.env.LANGFUSE_FANOUT_COLLECTOR_URL);
  const tenantDestination = resolveLangfuseTenantDestination(config?.destination);
  const tenantExportEmergencyEnabled = isLangfuseTenantExportEnabled();

  if (!usesLangfuseMultiTenantRouting()) {
    if (!centralTraceExportEnabled) {
      langfuse.enabled = false;
    } else if (hasLangfuseEnvCredentials()) {
      applyCentralEnvConfig(langfuse);
    } else if (tenantLangfuseEnabled && tenantCredentials != null && tenantDestination != null) {
      langfuse.publicKey = tenantCredentials.publicKey;
      langfuse.secretKey = tenantCredentials.secretKey;
      langfuse.baseUrl = tenantDestination.baseUrl;
    } else if (config != null) {
      langfuse.enabled = false;
    }
    return applyCustomHeaders(langfuse, additionalHeaders);
  }

  const exportPlan = resolveLangfuseExportPlan({
    centralTraceExportEnabled,
    fanoutEnabled,
    fanoutRequested,
    fanoutCollectorUrl,
    tenantLangfuseEnabled,
    hasTenantCredentials,
    tenantExportEmergencyEnabled,
    publicKey: tenantCredentials?.publicKey,
    secretKey: tenantCredentials?.secretKey,
    tenantDestination,
  });
  applyExportPlanTelemetry(langfuse, exportPlan, normalizedTenantId);

  switch (exportPlan.type) {
    case 'tenantFanout':
      langfuse.publicKey = exportPlan.publicKey;
      langfuse.secretKey = exportPlan.secretKey;
      langfuse.baseUrl = appendPath(
        exportPlan.collectorUrl,
        [
          '',
          'tenant',
          exportPlan.destination.key,
          ...(!centralTraceExportEnabled ? [CENTRAL_MEDIA_DISABLED_SEGMENT] : []),
        ].join('/'),
      );
      // Fanout routing stays destination-scoped by URL. `additionalHeaders` is
      // now available (and carries the deployment's proxy headers), but routing
      // multiple tenant Langfuse exports for one run by header would need the
      // collector to demultiplex them — the URL remains the app-to-gateway
      // routing contract until that is required.
      langfuse.librechatTraceAttributes = {
        ...(langfuse.librechatTraceAttributes ?? {}),
        [TENANT_EXPORT_ATTRIBUTE]: 'true',
        [TENANT_DESTINATION_ATTRIBUTE]: exportPlan.destination.key,
      };
      break;
    case 'fanoutCollector':
      langfuse.baseUrl = exportPlan.collectorUrl;
      if (isLangfuseCentralMediaUploadDisabled()) {
        langfuse.mediaUploadEnabled = false;
      }
      break;
    case 'disabled':
      langfuse.enabled = false;
      break;
    case 'directCentral':
      applyCentralEnvConfig(langfuse);
      break;
  }

  return applyCustomHeaders(langfuse, additionalHeaders);
}
