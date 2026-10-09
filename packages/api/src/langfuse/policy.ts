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

export function isLangfuseConnectionAvailable(): boolean {
  if (!isLangfuseTracingEnabled()) {
    return false;
  }
  if (usesLangfuseMultiTenantRouting()) {
    return isLangfuseFanoutEnabled() && isLangfuseTenantExportEnabled();
  }
  return !hasLangfuseEnvCredentials();
}
