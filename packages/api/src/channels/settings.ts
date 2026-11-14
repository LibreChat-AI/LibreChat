import { channelConfigSchema } from 'librechat-data-provider';
import type { ChannelConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/** Deployment scheduling bounds carry no tenant/principal enablement decision. */
export type ChannelWorkerSettings = Pick<
  ChannelConfig,
  'cleanup' | 'feedback' | 'maxMetadataPageSize' | 'leaseMs'
>;
export interface ChannelPolicySubject {
  tenantId: string;
  userId: string;
}
export interface ChannelFeedbackPolicySnapshot {
  appConfig: AppConfig;
  centralTraceExportEnabled: boolean;
}
export function channelWorkerSettings(input?: unknown): ChannelWorkerSettings {
  const { cleanup, feedback, maxMetadataPageSize, leaseMs } = channelConfigSchema.parse(
    input ?? {},
  );
  return { cleanup, feedback, maxMetadataPageSize, leaseMs };
}
