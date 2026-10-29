import { createServer } from 'node:http';
import { Registry, collectDefaultMetrics, Counter } from 'prom-client';
import { connectSocket } from './socket';
import { ChannelWorker } from './worker';
import { ChannelClient } from './client';
import { loadConfig } from './config';
import { SlackClient } from './slack';
import { GatewayApp } from './app';
import { logger } from './types';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'channel_gateway_' });
  const httpRequests = new Counter({
    name: 'channel_gateway_http_requests_total',
    help: 'Gateway HTTP requests by bounded outcome',
    labelNames: ['status'],
    registers: [registry],
  });
  const controller = new AbortController();
  const client = new ChannelClient(config);
  const slack = new SlackClient(config, logger);
  const app = new GatewayApp(config, client, slack, logger);
  const server = createServer((request, response) => {
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
    void app.http(request, response).catch(() => {
      logger.error('gateway_http_failed');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 128;
  const shutdown = () => {
    app.ready = false;
    controller.abort();
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    timer.unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.PORT, config.LISTEN_HOST, resolve);
  });
  try {
    const bundle = await client.channel(controller.signal);
    if (config.SLACK_TRANSPORT === 'socket_mode')
      await connectSocket(config, app, bundle.channel.slack.appId, logger, controller.signal);
    app.ready = true;
    logger.info('channel_gateway_started');
    await new ChannelWorker(config, client, slack, logger).run(controller.signal);
  } finally {
    shutdown();
  }
}

void main().catch(() => {
  logger.error('channel_gateway_startup_failed');
  process.exitCode = 1;
});
