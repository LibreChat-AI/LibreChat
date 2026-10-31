import { getTenantId } from '@librechat/data-schemas';
import { channelConfigSchema } from 'librechat-data-provider';
import type {
  AppConfig,
  IUser,
  AgentChannelRecord,
  ChannelRunRecord,
} from '@librechat/data-schemas';
import type { ChannelConfig } from 'librechat-data-provider';
import type { Request } from 'express';
import type {
  ChannelWorkerSettings,
  ChannelPolicySubject,
  ChannelFeedbackPolicySnapshot,
} from './settings';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import { isLangfuseTracingEnabled } from '~/langfuse/policy';
import { channelWorkerSettings } from './settings';

export interface ChannelApplicationPolicyDependencies {
  readAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  findUser: (query: { _id: string }) => Promise<IUser | null>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
}
export interface ChannelApplicationPolicy {
  config: (user?: IUser) => Promise<ChannelConfig>;
  workerSettings: () => Promise<ChannelWorkerSettings>;
  requestConfig: (req: Request, channel?: AgentChannelRecord) => Promise<ChannelConfig>;
  appConfig: (tenantId: string, principalId?: string) => Promise<AppConfig>;
  runConfig: (run: ChannelRunRecord) => Promise<AppConfig>;
  traceConfig: (run: ChannelRunRecord) => Promise<AppConfig['langfuse']>;
  feedbackPolicy: (owner: ChannelPolicySubject) => Promise<ChannelFeedbackPolicySnapshot | null>;
}
const applicationTenant = (tenantId?: string | null): string | undefined =>
  tenantId === '_' ? undefined : tenantId || undefined;

/** Application policy is resolved in the canonical tenant and includes current principal overrides. */
export function createChannelApplicationPolicy(
  deps: ChannelApplicationPolicyDependencies,
): ChannelApplicationPolicy {
  async function userConfig(user?: IUser): Promise<AppConfig> {
    const tenantId = applicationTenant(getTenantId());
    if (user && applicationTenant(user.tenantId) !== tenantId)
      throw new Error('Channel principal tenant changed');
    return deps.readAppConfig({
      tenantId,
      ...(user
        ? {
            userId: String(user._id),
            role: user.role || undefined,
            idOnTheSource: user.idOnTheSource,
          }
        : {}),
      failClosed: true,
    });
  }
  async function ownerConfig(tenantId: string, principalId?: string): Promise<AppConfig> {
    if (applicationTenant(tenantId) !== applicationTenant(getTenantId()))
      throw new Error('Channel policy tenant changed');
    if (!principalId) return userConfig();
    const user = await deps.findUser({ _id: principalId });
    if (!user || String(user._id) !== principalId)
      throw new Error('Channel policy principal unavailable');
    return userConfig(user);
  }
  return {
    workerSettings: async () =>
      channelWorkerSettings(
        (await deps.readAppConfig({ baseOnly: true, failClosed: true })).endpoints?.agents
          ?.channels,
      ),
    config: async (user) =>
      channelConfigSchema.parse((await userConfig(user)).endpoints?.agents?.channels ?? {}),
    requestConfig: async (req, channel) => {
      const config = channel
        ? await ownerConfig(channel.tenantId || '_', channel.createdBy)
        : await userConfig((req as ServerRequest).user);
      return channelConfigSchema.parse(config.endpoints?.agents?.channels ?? {});
    },
    appConfig: ownerConfig,
    runConfig: (run) => ownerConfig(run.tenantId, run.principal.userId),
    traceConfig: async (run) => (await ownerConfig(run.tenantId, run.principal.userId)).langfuse,
    feedbackPolicy: async (owner) => {
      if (applicationTenant(owner.tenantId) !== applicationTenant(getTenantId()))
        throw new Error('Channel policy tenant changed');
      if (!(await deps.isPrincipalActive(owner.userId))) return null;
      const appConfig = await ownerConfig(owner.tenantId, owner.userId);
      const config = channelConfigSchema.parse(appConfig.endpoints?.agents?.channels ?? {});
      if (!config.enabled || appConfig.interfaceConfig?.feedback === false) return null;
      return { appConfig, centralTraceExportEnabled: isLangfuseTracingEnabled() };
    },
  };
}
