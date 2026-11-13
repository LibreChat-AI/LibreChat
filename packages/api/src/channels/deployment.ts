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
    const publicServer = env.DOMAIN_SERVER;
    const publicClient = env.DOMAIN_CLIENT;
    if (!publicServer || !publicClient) throw new Error('Missing public application URLs');
    const gatewayUrl = env.SLACK_GATEWAY_URL || previous?.gatewayUrl;
    for (const value of [publicServer, publicClient, gatewayUrl]) {
      if (!value) continue;
      if (value !== value.trim())
        throw new Error('Public URLs must not contain surrounding whitespace');
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
    const channels = channelConfigSchema.parse({
      ...previous,
      enabled: true,
      transport: 'webhook',
      gatewayUrl,
      slackApp: {
        ...previous?.slackApp,
        enabled: true,
      },
    });
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
    // Schema diagnostics can contain submitted configuration values.
    throw new Error(
      'Invalid shared Slack setup. Configure public HTTPS DOMAIN_SERVER and DOMAIN_CLIENT without surrounding whitespace. SLACK_GATEWAY_URL must also use public HTTPS when set. Replace the localhost defaults.',
    );
  }
}
