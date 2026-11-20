import * as http from 'node:http';
import type { RequestInit, RequestInfo, Response } from 'undici';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  createScheduledMCPBearerHeaderResolver,
  attachScheduledMCPBearer,
} from '~/schedules/bearer';
import { createMCPRequestContext, quiesceMCPRequestContext } from '~/mcp/request';
import { MCPConnection } from '~/mcp/connection';

type Fetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

// Local redirect routing is allowed in this fixture; SSRF policy has its own integration suite.
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

describe.each(['HTTP GET', 'HTTP POST', 'redirect hop', 'legacy SSE GET'] as const)(
  '%s promise handoff',
  (transportType) => {
    it.each(['occurrence', 'connection', 'caller', 'owner'] as const)(
      'fences %s cancellation immediately before dispatch',
      async (cutoff) => {
        const paths: string[] = [];
        const server = http.createServer((req, res) => {
          paths.push(req.url!);
          res.writeHead(req.url === '/start' ? 307 : 200, { Location: '/resource' });
          res.end('{}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing listener');
        const context = createMCPRequestContext();
        const user = { id: 'owner' };
        const identity = {
          scheduleId: 'schedule',
          ownerId: user.id,
          tenantId: null,
          agentId: 'root',
          invocationMode: 'delegated' as const,
        };
        const config: ParsedServerConfig = {
          type: transportType === 'legacy SSE GET' ? 'sse' : 'streamable-http',
          url: `http://127.0.0.1:${address.port}/resource`,
          source: 'yaml',
          requiresOAuth: false,
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        };
        const ownerController = new AbortController();
        attachScheduledMCPBearer(
          context,
          identity,
          {
            bind: (captured) => ({
              identity: captured,
              reject: () => {},
              resolve: async (input) => ({
                ...input.config,
                headers: { Authorization: 'Bearer dispatch-only' },
              }),
            }),
          },
          'invoke',
          ownerController.signal,
        );
        const resolver = createScheduledMCPBearerHeaderResolver({
          context,
          user,
          serverName: 'Files',
          config,
        });
        const connection = new MCPConnection({
          serverName: 'handoff',
          serverConfig: config,
          resolveRequestHeaders: resolver,
        });
        const controller = new AbortController();
        const original = connection['authorizeRequestHeaders'].bind(connection);
        let authorized = 0;
        let closing: Promise<void> | undefined;
        const headers = jest
          .spyOn(
            connection as unknown as {
              authorizeRequestHeaders: (
                signal?: AbortSignal,
              ) => Promise<Record<string, string> | undefined>;
            },
            'authorizeRequestHeaders',
          )
          .mockImplementation(async (signal?: AbortSignal) => {
            const result = await original(signal);
            if (++authorized === (transportType === 'redirect hop' ? 2 : 1)) {
              // Run after the helper's last check but before its caller resumes.
              queueMicrotask(() => {
                if (cutoff === 'occurrence') closing = quiesceMCPRequestContext(context);
                else if (cutoff === 'connection') closing = connection.dispose();
                else if (cutoff === 'owner') ownerController.abort();
                else controller.abort();
              });
            }
            return result;
          });
        try {
          let fetch: Fetch;
          if (transportType === 'legacy SSE GET') {
            const transport = await connection['constructTransport'](config);
            fetch = Reflect.get(transport, '_eventSourceInit').fetch;
          } else
            fetch = connection['createFetchFunction'](
              () => undefined,
              1000,
              undefined,
              undefined,
              config.url,
            );
          const response = await fetch(
            transportType === 'redirect hop' ? new URL('/start', config.url).href : config.url!,
            {
              signal: controller.signal,
              method: transportType === 'HTTP POST' ? 'POST' : 'GET',
              ...(transportType === 'HTTP POST' && {
                body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
              }),
            },
          ).then(
            async (value) => {
              await value.body?.cancel();
              return value;
            },
            (error) => error,
          );
          await closing;
          expect(paths).toEqual(transportType === 'redirect hop' ? ['/start'] : []);
          expect(Reflect.get(response, 'name')).toBe('AbortError');
        } finally {
          headers.mockRestore();
          await closing;
          await connection.dispose();
          await quiesceMCPRequestContext(context);
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
      10_000,
    );
  },
);
