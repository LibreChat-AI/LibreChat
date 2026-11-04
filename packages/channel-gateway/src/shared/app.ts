import type { SharedSlackGatewayBootstrap } from 'librechat-data-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SharedGatewayConfig } from '../config';
import type { Logger } from '../types';
import { parseSignedWebhook, normalizeEvent } from '../events';
import { resolveGatewayConfig } from '../config';
import { ServiceError } from '../transport';
import { WorkspaceClient } from './client';
import { slackRouteLookup } from './route';
import { SlackHTTPServer } from '../http';
import { ChannelClient } from '../client';
import { SlackClient } from '../slack';
import { GatewayApp } from '../app';

export class SharedGatewayApp {
  ready = false;
  private readonly ingress: SlackHTTPServer;
  constructor(
    config: SharedGatewayConfig,
    client: WorkspaceClient,
    initial: SharedSlackGatewayBootstrap,
    log: Logger,
    transport: typeof fetch = fetch,
  ) {
    const slack = new SlackClient(config, log);
    this.ingress = new SlackHTTPServer({
      ready: () => this.ready,
      capacity: initial.workers.ingressConcurrency,
      match: (path) => {
        if (path === '/slack/events') return false;
        if (path === '/slack/interactions') return true;
        return undefined;
      },
      log,
      dispatch: async (body, headers, interactive, signal) => {
        const settings = await client.bootstrap(signal);
        const parsed = parseSignedWebhook(
          body,
          headers,
          {
            signingSecret: settings.signingSecret,
            signatureToleranceSeconds: settings.gateway.signatureToleranceSeconds,
          },
          interactive,
        );
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.code } };
        const request = parsed.request;
        if (request.kind === 'challenge')
          return { status: 200, body: { challenge: request.challenge } };
        if (
          request.kind === 'event' &&
          ['app_uninstalled', 'tokens_revoked'].includes(request.envelope.event.type)
        ) {
          if (request.envelope.api_app_id !== settings.appId)
            return { status: 400, body: { error: 'invalid_payload' } };
          await client.lifecycle(settings.appId, request.envelope.team_id, signal);
          return { status: 200, body: {} };
        }
        const lookup = slackRouteLookup(request, settings.appId);
        if (!lookup) return { status: 200, body: {} };
        let route;
        try {
          route = await client.route(lookup, signal);
        } catch (error) {
          // A removed installation or stale action is a definitive non-execution outcome.
          if (error instanceof ServiceError && error.status === 404)
            return { status: 200, body: {} };
          throw error;
        }
        if (route.kind !== 'bound') {
          if (request.kind === 'event') {
            const event = normalizeEvent(request.envelope, { channel: { slack: route.workspace } });
            if (event?.kind === 'message')
              await slack.ephemeral(
                route.botToken,
                {
                  channel: event.admission.externalChannelId,
                  user: event.admission.actor.externalUserId,
                  text:
                    route.kind === 'retired_thread'
                      ? 'This thread’s agent connection is no longer available. Start a new thread after an administrator updates the connection.'
                      : 'No agent is configured for this Slack conversation. Ask your LibreChat administrator to connect an agent.',
                },
                signal,
              );
          }
          return { status: 200, body: {} };
        }
        const scoped = resolveGatewayConfig(
          { ...config, CHANNEL_TENANT_ID: route.tenantId, CHANNEL_ID: route.channelId },
          settings.gateway,
        );
        const channel = new ChannelClient(scoped, transport);
        const bundle = await channel.channel(signal);
        if (
          bundle.channel.workspaceId !== route.workspaceId ||
          bundle.channel.slack.appId !== settings.appId ||
          bundle.channel.slack.teamId !== lookup.teamId
        )
          throw new Error('Slack installation changed during dispatch');
        const app = new GatewayApp(scoped, channel, slack, log);
        const payload = request.kind === 'event' ? request.envelope : request.payload;
        return {
          status: 200,
          body: (await app.dispatch(payload, interactive, signal, bundle)) ?? {},
        };
      },
    });
  }
  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.ingress.http(request, response);
  }
}
