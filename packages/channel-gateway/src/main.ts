import { createServer } from 'node:http';
import { Registry, collectDefaultMetrics, Counter } from 'prom-client';
import type { Server } from 'node:http';
import type { SocketConnection } from './socket';
import { loadConfig, resolveGatewayConfig } from './config';
import { connectSocket } from './socket';
import { ChannelWorker } from './worker';
import { ChannelClient } from './client';
import { SlackClient } from './slack';
import { GatewayApp } from './app';
import { logger } from './types';

async function main(): Promise<void> {
  const bootstrap = loadConfig(process.env);
  const controller = new AbortController();
  const client = new ChannelClient(bootstrap);
  let app: GatewayApp | undefined;
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
    const bundle = await client.channel(controller.signal);
    const config = resolveGatewayConfig(bootstrap, bundle.gateway);
    const registry = new Registry();
    collectDefaultMetrics({ register: registry, prefix: 'channel_gateway_' });
    const httpRequests = new Counter({
      name: 'channel_gateway_http_requests_total',
      help: 'Gateway HTTP requests by bounded outcome',
      labelNames: ['status'],
      registers: [registry],
    });
    const slack = new SlackClient(config, logger);
    const application = new GatewayApp(config, client, slack, logger);
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
    if (config.SLACK_TRANSPORT === 'socket_mode')
      connection = await connectSocket(
        config,
        application,
        bundle.channel.slack.appId,
        logger,
        controller.signal,
      );
    application.ready = true;
    logger.info('channel_gateway_started');
    worker = new ChannelWorker(config, client, slack, logger).run(controller.signal);
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

void main().catch(() => {
  logger.error('channel_gateway_startup_failed');
  process.exitCode = 1;
});
