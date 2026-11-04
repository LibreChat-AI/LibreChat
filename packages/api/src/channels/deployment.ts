import { isIP } from 'node:net';
import { agentsEndpointSchema, channelConfigSchema } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import {
  resolveSlackWorkspaceApp,
  slackPublicURL,
  SLACK_WORKSPACE_CALLBACK_PATH,
} from './workspaces';
import { getOAuthCallbackUrl } from '~/oauth/url';
import { isPrivateIP } from '~/auth/ip';
import { isEnabled } from '~/utils';

type DeploymentEnvironment = Partial<
  Record<
    | 'SLACK_WORKSPACES_ENABLED'
    | 'SLACK_APP_ID'
    | 'SLACK_CLIENT_ID'
    | 'SLACK_CLIENT_SECRET'
    | 'SLACK_SIGNING_SECRET'
    | 'SLACK_GATEWAY_URL'
    | 'DOMAIN_SERVER'
    | 'DOMAIN_CLIENT',
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
        appId: env.SLACK_APP_ID || previous?.slackApp?.appId,
        clientId: env.SLACK_CLIENT_ID || previous?.slackApp?.clientId,
        clientSecret: env.SLACK_CLIENT_SECRET || previous?.slackApp?.clientSecret,
        signingSecret: env.SLACK_SIGNING_SECRET || previous?.slackApp?.signingSecret,
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
    resolveSlackWorkspaceApp(
      channels,
      getOAuthCallbackUrl(publicServer, SLACK_WORKSPACE_CALLBACK_PATH),
    );
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
    // Schema diagnostics can contain submitted values, including deployment secrets.
    throw new Error(
      'Invalid shared Slack setup. Configure app credentials and a public HTTPS DOMAIN_SERVER; DOMAIN_CLIENT and SLACK_GATEWAY_URL must also use public HTTPS when set. Replace the localhost defaults.',
    );
  }
}
