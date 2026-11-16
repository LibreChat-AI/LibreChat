import { createServer } from 'node:http';
import { Registry, collectDefaultMetrics, Counter } from 'prom-client';
import type { Server } from 'node:http';
import type { SocketConnection } from './socket';
import { loadBootstrap, resolveGatewayConfig } from './config';
import { DiscordRuntimeClient } from './discord/discovery';
import { createDiscordTelemetry } from './discord/observe';
import { ChannelWorker, recoveryEvent } from './worker';
import { runSharedWorkers } from './shared/worker';
import { WorkspaceClient } from './shared/client';
import { DiscordGatewayApp } from './discord/app';
import { DiscordHealth } from './discord/health';
import { SharedGatewayApp } from './shared/app';
import { assertSlackBundle } from './types';
import { ServiceError } from './transport';
import { connectSocket } from './socket';
import { ChannelClient } from './client';
import { SlackClient } from './slack';
import { GatewayApp } from './app';
import { logger } from './types';

async function main(): Promise<void> {
  const bootstrap = loadBootstrap(process.env);
  const controller = new AbortController();
  let app: GatewayApp | SharedGatewayApp | DiscordGatewayApp | undefined;
  let server: Server | undefined;
  let connection: SocketConnection | undefined;
  let worker: Promise<void> | undefined;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (app) app.ready = false;
    controller.abort();
    if (server) {
      server.close();
      const listener = server;
      const timer = setTimeout(() => listener.closeAllConnections(), 5000);
      timer.unref();
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    const config = bootstrap.config;
    let application: GatewayApp | SharedGatewayApp | DiscordGatewayApp;
    let startWorker: () => Promise<void>;
    let startSocket: (() => Promise<SocketConnection>) | undefined;
    const registry = new Registry();
    collectDefaultMetrics({ register: registry, prefix: 'channel_gateway_' });
    if (bootstrap.mode === 'discord') {
      const client = new DiscordRuntimeClient(bootstrap.config);
      const settings = await client.bootstrap(controller.signal);
      const health = new DiscordHealth(settings.discord.health);
      const discord = new DiscordGatewayApp(
        bootstrap.config,
        settings.discord,
        logger,
        fetch,
        undefined,
        { telemetry: createDiscordTelemetry({ registry, health }), health },
      );
      application = discord;
      startWorker = () => discord.run(controller.signal);
    } else if (bootstrap.mode === 'shared') {
      const client = new WorkspaceClient(bootstrap.config);
      const settings = await client.bootstrap(controller.signal);
      application = new SharedGatewayApp(bootstrap.config, client, settings, logger);
      startWorker = () => runSharedWorkers(bootstrap.config, client, logger, controller.signal);
    } else {
      const client = new ChannelClient(bootstrap.config);
      const bundle = await client.channel(controller.signal);
      assertSlackBundle(bundle);
      const runtime = resolveGatewayConfig(bootstrap.config, bundle.gateway);
      const slack = new SlackClient(runtime, logger);
      const boundApp = new GatewayApp(runtime, client, slack, logger);
      application = boundApp;
      if (runtime.SLACK_TRANSPORT === 'socket_mode')
        startSocket = () =>
          connectSocket(runtime, boundApp, bundle.channel.slack.appId, logger, controller.signal);
      startWorker = () => new ChannelWorker(runtime, client, slack, logger).run(controller.signal);
    }
    const httpRequests = new Counter({
      name: 'channel_gateway_http_requests_total',
      help: 'Gateway HTTP requests by bounded outcome',
      labelNames: ['status'],
      registers: [registry],
    });
    app = application;
    const listener = createServer((request, response) => {
      response.on('finish', () => httpRequests.labels(String(response.statusCode)).inc());
      if (request.method === 'GET' && request.url === '/metrics') {
        void registry
          .metrics()
          .then((metrics) => {
            response.writeHead(200, { 'Content-Type': registry.contentType });
            response.end(metrics);
          })
          .catch(() => {
            response.writeHead(500);
            response.end();
          });
        return;
      }
      void application.http(request, response).catch(() => {
        logger.error('gateway_http_failed');
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server = listener;
    listener.requestTimeout = 5000;
    listener.headersTimeout = 5000;
    listener.maxConnections = 128;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(config.PORT, config.LISTEN_HOST, resolve);
    });
    controller.signal.throwIfAborted();
    if (startSocket) connection = await startSocket();
    application.ready = true;
    logger.info('channel_gateway_started');
    worker = startWorker();
    if (connection)
      await Promise.race([
        worker,
        connection.closed.then(() => {
          if (!controller.signal.aborted) throw new Error('Socket supervision ended');
        }),
      ]);
    else await worker;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    shutdown();
    await Promise.allSettled([worker, connection?.closed]);
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof ServiceError) logger.error(recoveryEvent(error));
  logger.error('channel_gateway_startup_failed');
  process.exitCode = 1;
});
