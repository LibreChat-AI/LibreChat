import { isIP } from 'node:net';
import { agentsEndpointSchema, channelConfigSchema } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import { slackPublicURL } from './workspaces';
import { isPrivateIP } from '~/auth/ip';
import { isEnabled } from '~/utils';

type DeploymentEnvironment = Partial<
  Record<
    'SLACK_WORKSPACES_ENABLED' | 'SLACK_GATEWAY_URL' | 'DOMAIN_SERVER' | 'DOMAIN_CLIENT',
    string
  >
>;

/** Explicit deployment opt-in supplies shared-app settings without replacing librechat.yaml. */
export function applySlackWorkspaceEnvironment(
  config: Partial<TCustomConfig>,
  env: DeploymentEnvironment,
): Partial<TCustomConfig> {
  if (!isEnabled(env.SLACK_WORKSPACES_ENABLED)) return config;
  const agents = config.endpoints?.agents;
  const previous = agents?.channels;
  try {
    const publicServer = env.DOMAIN_SERVER?.trim();
    if (!publicServer) throw new Error('Missing DOMAIN_SERVER');
    const channels = channelConfigSchema.parse({
      ...previous,
      enabled: true,
      transport: 'webhook',
      gatewayUrl: env.SLACK_GATEWAY_URL || previous?.gatewayUrl,
      slackApp: {
        ...previous?.slackApp,
        enabled: true,
      },
    });
    for (const value of [publicServer, env.DOMAIN_CLIENT || publicServer, channels.gatewayUrl]) {
      if (!value) continue;
      const url = slackPublicURL(value);
      const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (
        url.protocol !== 'https:' ||
        host === 'localhost' ||
        host === 'localhost.localdomain' ||
        host.endsWith('.localhost') ||
        (isIP(host) && isPrivateIP(host))
      )
        throw new Error('Shared deployment requires public HTTPS URLs');
    }
    return {
      ...config,
      endpoints: {
        ...config.endpoints,
        agents: agentsEndpointSchema.parse({
          ...agents,
          channels,
          remoteApi: {
            ...agents?.remoteApi,
            background: { ...agents?.remoteApi?.background, enabled: true },
          },
        }),
      },
    };
  } catch {
    // Schema diagnostics can contain submitted values, including submitted values.
    throw new Error(
      'Invalid shared Slack setup. Configure a public HTTPS DOMAIN_SERVER; DOMAIN_CLIENT and SLACK_GATEWAY_URL must also use public HTTPS when set. Replace the localhost defaults.',
    );
  }
}
