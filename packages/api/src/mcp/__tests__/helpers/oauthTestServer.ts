import { z } from 'zod';
import * as net from 'net';
import * as http from 'http';
import { randomUUID, createHash } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TokenMethods } from '@librechat/data-schemas';
import type { Socket } from 'net';
import type { FlowState } from '~/flow/types';

export class MockKeyv<T = unknown> {
  private store: Map<string, FlowState<T>>;

  constructor() {
    this.store = new Map();
  }

  async get(key: string): Promise<FlowState<T> | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: FlowState<T>, _ttl?: number): Promise<true> {
    this.store.set(key, value);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

export function trackSockets(httpServer: http.Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      httpServer.close(() => resolve());
    });
}

export interface OAuthTestServerOptions {
  tokenTTLMs?: number;
  issueRefreshTokens?: boolean;
  refreshTokenTTLMs?: number;
  rotateRefreshTokens?: boolean;
  /** When true, /token validates client_id against the registered client that initiated /authorize */
  enforceClientId?: boolean;
  /** Scopes attached to newly issued tokens unless the authorization request asks for a scope. */
  tokenScopes?: string[];
  /** Scopes required by the protected MCP resource. Missing scopes produce a 403 insufficient_scope challenge. */
  requiredScopes?: string[];
  /** Scopes advertised by OAuth Protected Resource Metadata and authorization server metadata. */
  scopesSupported?: string[];
  /** When true, /authorize and /token reject requests that omit the MCP resource parameter. */
  requireResourceParameter?: boolean;
  /** Number of refresh-grant access tokens the MCP resource should reject after issuance. */
  rejectRefreshTokens?: number;
  /** Injects an endpoint failure before redemption; undefined resumes normal refresh behavior. */
  refreshFailure?: () => { status: number; body: string } | undefined;
  /**
   * Awaited after a refresh grant is recorded but before it is redeemed, so a test can hold
   * concurrent refreshes open and observe how many redemptions the callers actually attempt.
   */
  refreshGate?: () => Promise<void> | undefined;
  /** Optional test hook for controlling echo-tool completion. */
  echoHandler?: (message: string) => string | Promise<string>;
  /** Observes MCP resource requests, including unauthenticated and cancellation POSTs. */
  onResourceRequest?: (request: http.IncomingMessage) => void;
}

export interface OAuthTokenRequestRecord {
  grantType: string | null;
  resource: string | null;
  scope: string | null;
  clientId: string | null;
}

export interface OAuthTestServer {
  url: string;
  resourceUrl: string;
  port: number;
  close: () => Promise<void>;
  issuedTokens: Set<string>;
  tokenTTL: number;
  tokenIssueTimes: Map<string, number>;
  issuedRefreshTokens: Map<string, string>;
  registeredClients: Map<string, { client_id: string; client_secret: string }>;
  tokenRequests: OAuthTokenRequestRecord[];
  getAuthCode: () => Promise<string>;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString();
}

function parseBasicAuth(
  header: string | undefined,
): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith('Basic ')) {
    return null;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const [clientId, clientSecret] = decoded.split(':');
  return clientId ? { clientId, clientSecret: clientSecret ?? '' } : null;
}

function parseTokenRequest(body: string, contentType: string | undefined): URLSearchParams | null {
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body);
  }
  if (contentType?.includes('application/json')) {
    const json = JSON.parse(body) as Record<string, string>;
    return new URLSearchParams(json);
  }
  return new URLSearchParams(body);
}

export async function createOAuthMCPServer(
  options: OAuthTestServerOptions = {},
): Promise<OAuthTestServer> {
  const {
    tokenTTLMs = 60000,
    issueRefreshTokens = false,
    refreshTokenTTLMs = 365 * 24 * 60 * 60 * 1000,
    rotateRefreshTokens = false,
    enforceClientId = false,
    tokenScopes = [],
    requiredScopes = [],
    scopesSupported = [...new Set([...tokenScopes, ...requiredScopes])],
    requireResourceParameter = false,
    rejectRefreshTokens = 0,
    echoHandler,
    onResourceRequest,
    refreshFailure,
    refreshGate,
  } = options;

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const issuedTokens = new Set<string>();
  const tokenIssueTimes = new Map<string, number>();
  const accessTokenScopes = new Map<string, string[]>();
  const issuedRefreshTokens = new Map<string, string>();
  const refreshTokenIssueTimes = new Map<string, number>();
  const refreshTokenScopes = new Map<string, string[]>();
  const tokenRequests: OAuthTokenRequestRecord[] = [];
  const authCodes = new Map<
    string,
    {
      codeChallenge?: string;
      codeChallengeMethod?: string;
      clientId?: string;
      resource?: string;
      scope?: string;
    }
  >();
  const registeredClients = new Map<string, { client_id: string; client_secret: string }>();
  let rejectedRefreshTokensRemaining = rejectRefreshTokens;

  let port = 0;
  const getBaseUrl = () => `http://127.0.0.1:${port}`;
  const getResourceUrl = () => `${getBaseUrl()}/`;
  const getResourceMetadataUrl = () => `${getBaseUrl()}/.well-known/oauth-protected-resource`;

  const parseScopes = (scope: string | null | undefined): string[] => {
    if (!scope) {
      return tokenScopes;
    }
    return scope.split(/\s+/).filter(Boolean);
  };

  const writeJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const writeBearerChallenge = (
    res: http.ServerResponse,
    status: number,
    error: 'invalid_token' | 'insufficient_scope',
    description: string,
  ): void => {
    let authenticate = `Bearer error="${error}", error_description="${description}", resource_metadata="${getResourceMetadataUrl()}"`;
    if (requiredScopes.length > 0) {
      authenticate += `, scope="${requiredScopes.join(' ')}"`;
    }
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': authenticate,
    });
    res.end(JSON.stringify({ error, error_description: description }));
  };

  const requireValidResourceParameter = (
    res: http.ServerResponse,
    params: URLSearchParams,
  ): boolean => {
    if (!requireResourceParameter) {
      return true;
    }
    if (params.get('resource') === getResourceUrl()) {
      return true;
    }
    writeJson(res, 400, {
      error: 'invalid_target',
      error_description: 'resource parameter is required for this MCP resource',
    });
    return false;
  };

  const makeTokenResponse = (
    accessToken: string,
    scopes: string[],
  ): Record<string, string | number> => {
    const tokenResponse: Record<string, string | number> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.ceil(tokenTTLMs / 1000),
    };
    if (scopes.length > 0) {
      tokenResponse.scope = scopes.join(' ');
    }
    return tokenResponse;
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: getBaseUrl(),
          authorization_endpoint: `${getBaseUrl()}/authorize`,
          token_endpoint: `${getBaseUrl()}/token`,
          registration_endpoint: `${getBaseUrl()}/register`,
          scopes_supported: scopesSupported,
          response_types_supported: ['code'],
          grant_types_supported: issueRefreshTokens
            ? ['authorization_code', 'refresh_token']
            : ['authorization_code'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          resource: getResourceUrl(),
          authorization_servers: [getBaseUrl()],
          scopes_supported: scopesSupported,
          bearer_methods_supported: ['header'],
        }),
      );
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const data = JSON.parse(body) as { redirect_uris?: string[] };
      const clientId = `client-${randomUUID().slice(0, 8)}`;
      const clientSecret = `secret-${randomUUID()}`;
      registeredClients.set(clientId, { client_id: clientId, client_secret: clientSecret });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uris: data.redirect_uris ?? [],
        }),
      );
      return;
    }

    if (url.pathname === '/authorize') {
      if (requireResourceParameter && url.searchParams.get('resource') !== getResourceUrl()) {
        writeJson(res, 400, {
          error: 'invalid_target',
          error_description: 'resource parameter is required for this MCP resource',
        });
        return;
      }
      const code = randomUUID();
      const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? undefined;
      const clientId = url.searchParams.get('client_id') ?? undefined;
      const resource = url.searchParams.get('resource') ?? undefined;
      const scope = url.searchParams.get('scope') ?? undefined;
      authCodes.set(code, { codeChallenge, codeChallengeMethod, clientId, resource, scope });
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      res.writeHead(302, {
        Location: `${redirectUri}?code=${code}&state=${state}`,
      });
      res.end();
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const params = parseTokenRequest(body, req.headers['content-type']);
      if (!params) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }

      const grantType = params.get('grant_type');
      tokenRequests.push({
        grantType,
        resource: params.get('resource'),
        scope: params.get('scope'),
        clientId:
          params.get('client_id') ?? parseBasicAuth(req.headers.authorization)?.clientId ?? null,
      });

      if (!requireValidResourceParameter(res, params)) {
        return;
      }

      if (grantType === 'authorization_code') {
        const code = params.get('code');
        const codeData = code ? authCodes.get(code) : undefined;
        if (!code || !codeData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        if (codeData.codeChallenge) {
          const codeVerifier = params.get('code_verifier');
          if (!codeVerifier) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          if (codeData.codeChallengeMethod === 'S256') {
            const expected = createHash('sha256').update(codeVerifier).digest('base64url');
            if (expected !== codeData.codeChallenge) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_grant' }));
              return;
            }
          }
        }

        if (enforceClientId && codeData.clientId) {
          const requestClientId =
            params.get('client_id') ?? parseBasicAuth(req.headers.authorization)?.clientId;
          if (!requestClientId || !registeredClients.has(requestClientId)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_client' }));
            return;
          }
          if (requestClientId !== codeData.clientId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: 'invalid_client', error_description: 'client_id mismatch' }),
            );
            return;
          }
        }

        authCodes.delete(code);

        const accessToken = randomUUID();
        const scopes = parseScopes(codeData.scope);
        issuedTokens.add(accessToken);
        tokenIssueTimes.set(accessToken, Date.now());
        accessTokenScopes.set(accessToken, scopes);

        const tokenResponse = makeTokenResponse(accessToken, scopes);

        if (issueRefreshTokens) {
          const refreshToken = randomUUID();
          issuedRefreshTokens.set(refreshToken, accessToken);
          refreshTokenIssueTimes.set(refreshToken, Date.now());
          refreshTokenScopes.set(refreshToken, scopes);
          tokenResponse.refresh_token = refreshToken;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokenResponse));
        return;
      }

      if (grantType === 'refresh_token' && issueRefreshTokens) {
        await refreshGate?.();
        const failure = refreshFailure?.();
        if (failure) {
          res.writeHead(failure.status, { 'Content-Type': 'application/json' });
          res.end(failure.body);
          return;
        }

        const refreshToken = params.get('refresh_token');
        if (!refreshToken || !issuedRefreshTokens.has(refreshToken)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        const issueTime = refreshTokenIssueTimes.get(refreshToken) ?? 0;
        if (Date.now() - issueTime > refreshTokenTTLMs) {
          issuedRefreshTokens.delete(refreshToken);
          refreshTokenIssueTimes.delete(refreshToken);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        const newAccessToken = randomUUID();
        const scopes = params.has('scope')
          ? parseScopes(params.get('scope'))
          : (refreshTokenScopes.get(refreshToken) ?? tokenScopes);
        if (rejectedRefreshTokensRemaining > 0) {
          rejectedRefreshTokensRemaining -= 1;
        } else {
          issuedTokens.add(newAccessToken);
        }
        tokenIssueTimes.set(newAccessToken, Date.now());
        accessTokenScopes.set(newAccessToken, scopes);

        const tokenResponse = makeTokenResponse(newAccessToken, scopes);

        if (rotateRefreshTokens) {
          issuedRefreshTokens.delete(refreshToken);
          refreshTokenIssueTimes.delete(refreshToken);
          refreshTokenScopes.delete(refreshToken);
          const newRefreshToken = randomUUID();
          issuedRefreshTokens.set(newRefreshToken, newAccessToken);
          refreshTokenIssueTimes.set(newRefreshToken, Date.now());
          refreshTokenScopes.set(newRefreshToken, scopes);
          tokenResponse.refresh_token = newRefreshToken;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokenResponse));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    // All other paths require Bearer token auth
    onResourceRequest?.(req);
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      writeBearerChallenge(res, 401, 'invalid_token', 'Missing Authorization header');
      return;
    }

    const token = authHeader.slice(7);
    if (!issuedTokens.has(token)) {
      writeBearerChallenge(res, 401, 'invalid_token', 'Token is invalid');
      return;
    }

    const issueTime = tokenIssueTimes.get(token) ?? 0;
    if (Date.now() - issueTime > tokenTTLMs) {
      issuedTokens.delete(token);
      tokenIssueTimes.delete(token);
      accessTokenScopes.delete(token);
      writeBearerChallenge(res, 401, 'invalid_token', 'Token has expired');
      return;
    }

    const scopes = accessTokenScopes.get(token) ?? [];
    const hasRequiredScopes = requiredScopes.every((scope) => scopes.includes(scope));
    if (!hasRequiredScopes) {
      writeBearerChallenge(res, 403, 'insufficient_scope', 'Insufficient scope');
      return;
    }

    // Authenticated MCP request — route to transport
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const mcp = new McpServer({ name: 'oauth-test-server', version: '0.0.1' });
      mcp.tool('echo', { message: z.string() }, async (args) => {
        const text = echoHandler ? await echoHandler(args.message) : `echo: ${args.message}`;
        return { content: [{ type: 'text' as const, text }] };
      });
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);

    if (transport.sessionId && !sessions.has(transport.sessionId)) {
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport!.sessionId!);
    }
  });

  const destroySockets = trackSockets(httpServer);
  port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    resourceUrl: `http://127.0.0.1:${port}/`,
    port,
    issuedTokens,
    tokenTTL: tokenTTLMs,
    tokenIssueTimes,
    issuedRefreshTokens,
    registeredClients,
    tokenRequests,
    getAuthCode: async () => {
      const authUrl = new URL(`${getBaseUrl()}/authorize`);
      authUrl.searchParams.set('redirect_uri', 'http://localhost');
      authUrl.searchParams.set('state', 'test');
      if (requireResourceParameter) {
        authUrl.searchParams.set('resource', getResourceUrl());
      }
      const authRes = await fetch(authUrl, { redirect: 'manual' });
      const location = authRes.headers.get('location') ?? '';
      return new URL(location).searchParams.get('code') ?? '';
    },
    close: async () => {
      const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

export interface InMemoryToken {
  userId: string;
  type: string;
  identifier: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  metadata?: Map<string, unknown> | Record<string, unknown>;
}

export class InMemoryTokenStore {
  private tokens: Map<string, InMemoryToken> = new Map();

  private getCredentialSetId(token: InMemoryToken): unknown {
    return token.metadata instanceof Map
      ? token.metadata.get('credential_set_id')
      : token.metadata?.credential_set_id;
  }

  private key(filter: { userId?: string; type?: string; identifier?: string }): string {
    return `${filter.userId}:${filter.type}:${filter.identifier}`;
  }

  findToken = (async (filter: {
    userId?: string;
    type?: string;
    identifier?: string;
    token?: string;
    metadataCredentialSetId?: string | null;
  }): Promise<InMemoryToken | null> => {
    for (const token of this.tokens.values()) {
      const matchUserId = !filter.userId || token.userId === filter.userId;
      const matchType = !filter.type || token.type === filter.type;
      const matchIdentifier = !filter.identifier || token.identifier === filter.identifier;
      const matchToken = !filter.token || token.token === filter.token;
      const matchCredentialSet =
        filter.metadataCredentialSetId === undefined ||
        (filter.metadataCredentialSetId === null
          ? this.getCredentialSetId(token) == null
          : this.getCredentialSetId(token) === filter.metadataCredentialSetId);
      if (matchUserId && matchType && matchIdentifier && matchToken && matchCredentialSet) {
        return token;
      }
    }
    return null;
  }) as unknown as TokenMethods['findToken'];

  createToken = (async (data: {
    userId: string;
    type: string;
    identifier: string;
    token: string;
    expiresIn?: number;
    metadata?: Record<string, unknown>;
  }): Promise<InMemoryToken> => {
    const expiresIn = data.expiresIn ?? 365 * 24 * 60 * 60;
    const token: InMemoryToken = {
      userId: data.userId,
      type: data.type,
      identifier: data.identifier,
      token: data.token,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      createdAt: new Date(),
      metadata: data.metadata,
    };
    this.tokens.set(this.key(data), token);
    return token;
  }) as unknown as TokenMethods['createToken'];

  updateToken = (async (
    filter: {
      userId?: string;
      type?: string;
      identifier?: string;
      token?: string;
      metadataCredentialSetId?: string | null;
    },
    data: {
      userId?: string;
      type?: string;
      identifier?: string;
      token?: string;
      expiresAt?: Date;
      expiresIn?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<InMemoryToken | null> => {
    const existing = (await this.findToken(filter)) as InMemoryToken | null;
    if (!existing) {
      return null;
    }
    const existingKey = this.key(existing);
    const expiresIn =
      data.expiresIn ?? Math.floor((existing.expiresAt.getTime() - Date.now()) / 1000);
    const updated: InMemoryToken = {
      ...existing,
      token: data.token ?? existing.token,
      expiresAt:
        data.expiresAt ??
        (data.expiresIn !== undefined
          ? new Date(Date.now() + expiresIn * 1000)
          : existing.expiresAt),
      metadata: data.metadata ?? existing.metadata,
    };
    this.tokens.set(existingKey, updated);
    return updated;
  }) as unknown as TokenMethods['updateToken'];

  deleteToken = async (filter: {
    userId: string;
    type: string;
    identifier: string;
  }): Promise<void> => {
    this.tokens.delete(this.key(filter));
  };

  deleteTokens = (async (query: {
    userId?: string;
    type?: string;
    identifier?: string;
    token?: string;
    metadataCredentialSetId?: string | null;
  }): Promise<{ acknowledged: boolean; deletedCount: number }> => {
    let deletedCount = 0;
    for (const [key, token] of this.tokens.entries()) {
      const match =
        (!query.userId || token.userId === query.userId) &&
        (!query.type || token.type === query.type) &&
        (!query.identifier || token.identifier === query.identifier) &&
        (!query.token || token.token === query.token) &&
        (query.metadataCredentialSetId === undefined ||
          (query.metadataCredentialSetId === null
            ? this.getCredentialSetId(token) == null
            : this.getCredentialSetId(token) === query.metadataCredentialSetId));
      if (match) {
        this.tokens.delete(key);
        deletedCount++;
      }
    }
    return { acknowledged: true, deletedCount };
  }) as unknown as TokenMethods['deleteTokens'];

  getAll(): InMemoryToken[] {
    return [...this.tokens.values()];
  }

  clear(): void {
    this.tokens.clear();
  }
}
