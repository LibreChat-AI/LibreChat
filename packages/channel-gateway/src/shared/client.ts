import { z } from 'zod';
import {
  channelGatewayWirePolicySchema,
  sharedSlackGatewayWirePolicySchema,
  tenantIdSchema,
} from 'librechat-data-provider';
import type {
  SharedSlackGatewayBootstrap,
  SharedSlackRoute,
  SharedSlackRouteLookup,
} from 'librechat-data-provider';
import type { SharedGatewayConfig } from '../config';
import { ServiceClient } from '../transport';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/);
const bootstrapSchema = z.object({
  appId: identifier,
  signingSecret: z.string().min(1).max(512),
  gateway: channelGatewayWirePolicySchema,
  workers: sharedSlackGatewayWirePolicySchema,
});
const scopeSchema = z.object({ tenantId: tenantIdSchema, channelId: identifier });
const workspaceSchema = z.object({
  tenantId: tenantIdSchema.optional(),
  workspaceId: identifier,
  appId: identifier,
  teamId: identifier,
  teamName: z.string().min(1).max(256),
  botUserId: identifier,
  status: z.literal('active'),
  revision: identifier,
  scopes: z.array(z.string()),
});
const routeSchema = z.discriminatedUnion('kind', [
  scopeSchema.extend({ kind: z.literal('bound'), workspaceId: identifier }),
  z.object({
    kind: z.enum(['unmapped', 'retired_thread']),
    workspace: workspaceSchema,
    botToken: z.string().startsWith('xoxb-').min(6).max(512),
  }),
]);
const root = '/api/channels/service/workspaces';

export class WorkspaceClient extends ServiceClient {
  constructor(
    readonly config: SharedGatewayConfig,
    transport: typeof fetch = fetch,
  ) {
    super(config, transport);
  }
  async bootstrap(signal?: AbortSignal): Promise<SharedSlackGatewayBootstrap> {
    const result = bootstrapSchema.parse(await this.request<unknown>(root, undefined, signal));
    if (
      result.gateway.transport !== 'webhook' ||
      (this.config.SLACK_TRANSPORT && this.config.SLACK_TRANSPORT !== 'webhook')
    )
      throw new Error('Shared Slack workspaces require webhook transport');
    return result;
  }
  async route(lookup: SharedSlackRouteLookup, signal?: AbortSignal): Promise<SharedSlackRoute> {
    return routeSchema.parse(await this.request<unknown>(`${root}/resolve`, lookup, signal));
  }
  async discover(
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ tenantId: string; channelId: string }>> {
    return z
      .array(scopeSchema)
      .max(limit)
      .parse(await this.request<unknown>(`${root}/discover`, { limit }, signal));
  }
  async lifecycle(appId: string, teamId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`${root}/lifecycle`, { appId, teamId }, signal, true);
  }
}
