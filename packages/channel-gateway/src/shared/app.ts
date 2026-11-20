import { SLACK_CHANNEL_LIFECYCLE_EVENTS } from 'librechat-data-provider';
import type { SharedSlackGatewayBootstrap } from 'librechat-data-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SharedGatewayConfig } from '../config';
import type { Logger } from '../types';
import { parseSignedWebhook, normalizeEvent } from '../events';
import { SlackClient, SlackWriteError } from '../slack';
import { resolveGatewayConfig } from '../config';
import { ServiceError } from '../transport';
import { WorkspaceClient } from './client';
import { slackRouteLookup } from './route';
import { SlackHTTPServer } from '../http';
import { ChannelClient } from '../client';
import { GatewayApp } from '../app';

const callback = /^\/slack\/(events|interactions)\/([-\w.]{1,128})\/(A[A-Z0-9]{1,255})$/;
const lifecycleEvents = new Set<string>(SLACK_CHANNEL_LIFECYCLE_EVENTS);

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
        const match = callback.exec(path);
        return match ? match[1] === 'interactions' : undefined;
      },
      log,
      dispatch: async (body, headers, interactive, signal, path) => {
        const scope = callback.exec(path);
        if (!scope) return { status: 404, body: { error: 'not_found' } };
        const [, , tenantId, appId] = scope;
        const settings = await client.bootstrap(signal);
        let security;
        try {
          security = await client.app(tenantId, appId, signal);
        } catch (error) {
          if (error instanceof ServiceError && error.status === 404)
            return { status: 404, body: { error: 'not_found' } };
          throw error;
        }
        const parsed = parseSignedWebhook(
          body,
          headers,
          {
            signingSecret: security.signingSecret,
            signatureToleranceSeconds: settings.gateway.signatureToleranceSeconds,
          },
          interactive,
        );
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.code } };
        const request = parsed.request;
        if (request.kind === 'challenge')
          return { status: 200, body: { challenge: request.challenge } };
        if (request.kind === 'event' && lifecycleEvents.has(request.envelope.event.type)) {
          if (request.envelope.api_app_id !== appId)
            return { status: 400, body: { error: 'invalid_payload' } };
          await client.lifecycle(tenantId, appId, request.envelope.team_id, signal);
          return { status: 200, body: {} };
        }
        const lookup = slackRouteLookup(request, appId);
        if (!lookup) return { status: 200, body: {} };
        let route;
        try {
          route = await client.route(tenantId, lookup, signal);
        } catch (error) {
          // A removed installation or stale action is a definitive non-execution outcome.
          if (error instanceof ServiceError && error.status === 404)
            return { status: 200, body: {} };
          throw error;
        }
        if (route.kind !== 'bound') {
          if (
            (route.workspace.tenantId || '_') !== tenantId ||
            route.workspace.appId !== appId ||
            route.workspace.teamId !== lookup.teamId
          )
            throw new Error('Slack workspace scope changed');
          if (request.kind === 'event') {
            const event = normalizeEvent(request.envelope, { channel: { slack: route.workspace } });
            if (event?.kind === 'message') {
              try {
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
              } catch (error) {
                if (!(error instanceof SlackWriteError) || error.outcome !== 'permanent')
                  throw error;
                log.warn('slack_routing_notice_rejected');
              }
            }
          }
          return { status: 200, body: {} };
        }
        if (route.tenantId !== tenantId) throw new Error('Slack route tenant changed');
        const scoped = resolveGatewayConfig(
          { ...config, CHANNEL_TENANT_ID: route.tenantId, CHANNEL_ID: route.channelId },
          settings.gateway,
        );
        const channel = new ChannelClient(scoped, transport);
        const bundle = await channel.channel(signal);
        if (
          bundle.channel.workspaceId !== route.workspaceId ||
          bundle.channel.slack.appId !== appId ||
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
