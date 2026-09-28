import type { MCPToolsChangedEvent } from './toolsChanged';
import type { ParsedServerConfig } from './types';
import {
  setMCPToolsChangedHandler,
  setMCPToolsChangedGenerationHandler,
  setMCPToolsChangedGenerationRenewalHandler,
  setMCPToolsChangedRevisionHandler,
  getMCPToolsChangedGeneration,
  renewMCPToolsChangedGeneration,
  reserveMCPToolsChangedRevision,
  hasMCPToolsChangedHandler,
  cancelMCPToolsChanged,
  notifyMCPToolsChanged,
  getMCPAppToolsPublicationGeneration,
} from './toolsChanged';

const createEvent = (name = 'one'): MCPToolsChangedEvent => ({
  serverName: 'dynamic',
  serverConfig: { type: 'streamable-http', url: 'https://mcp.example.com' },
  tools: [{ name, inputSchema: { type: 'object' } }],
});

describe('MCP tools-changed dispatch', () => {
  afterEach(() => {
    setMCPToolsChangedHandler(null);
    setMCPToolsChangedGenerationHandler(null);
    setMCPToolsChangedGenerationRenewalHandler(null);
    setMCPToolsChangedRevisionHandler(null);
    jest.useRealTimers();
  });

  it('reports whether a handler is registered', () => {
    expect(hasMCPToolsChangedHandler()).toBe(false);
    setMCPToolsChangedHandler(jest.fn());
    expect(hasMCPToolsChangedHandler()).toBe(true);
    setMCPToolsChangedHandler(null);
    expect(hasMCPToolsChangedHandler()).toBe(false);
  });

  it('derives stable app publication generations from connection-relevant config', () => {
    const first: ParsedServerConfig = {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token', Accept: 'text/event-stream' },
      updatedAt: 1,
      toolFunctions: {},
    };
    const equivalent: ParsedServerConfig = {
      headers: { Accept: 'text/event-stream', Authorization: 'Bearer token' },
      url: 'https://mcp.example.com/sse',
      type: 'sse',
      updatedAt: 2,
      inspectionFailed: true,
    };
    const changed: ParsedServerConfig = {
      ...equivalent,
      url: 'https://mcp.example.com/v2/sse',
    };

    expect(getMCPAppToolsPublicationGeneration(first)).toBe(
      getMCPAppToolsPublicationGeneration(equivalent),
    );
    expect(getMCPAppToolsPublicationGeneration(first)).not.toBe(
      getMCPAppToolsPublicationGeneration(changed),
    );
  });

  it('keeps catalog headers and request overrides in the server identity', () => {
    const declared: ParsedServerConfig = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Workspace': 'catalog-1' },
      requestHeaders: { 'X-Workspace': 'chat' },
    };
    const generation = getMCPAppToolsPublicationGeneration(declared);
    expect(
      getMCPAppToolsPublicationGeneration({
        ...declared,
        headers: { 'X-Workspace': 'catalog-2' },
      }),
    ).not.toBe(generation);
    expect(
      getMCPAppToolsPublicationGeneration({
        ...declared,
        requestHeaders: { 'X-Workspace': 'chat-2' },
      }),
    ).not.toBe(generation);
    expect(
      getMCPAppToolsPublicationGeneration({
        ...declared,
        headers: { 'X-Workspace': 'chat' },
        requestHeaders: undefined,
      }),
    ).not.toBe(generation);
  });

  it('rotates the declared identity when a chat override of the catalog API key changes', () => {
    const config: ParsedServerConfig = {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      source: 'yaml',
      apiKey: { source: 'admin', authorization_type: 'bearer', key: 'catalog' },
      requestHeaders: { Authorization: 'Bearer chat-one' },
    };
    expect(getMCPAppToolsPublicationGeneration(config)).not.toBe(
      getMCPAppToolsPublicationGeneration({
        ...config,
        requestHeaders: { Authorization: 'Bearer chat-two' },
      }),
    );
  });

  it('includes request-header environment changes without mutating the declaration', () => {
    const variable = 'MCP_REQUEST_HEADER_GENERATION_TEST';
    const original = process.env[variable];
    const config: ParsedServerConfig = {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      source: 'yaml',
      requestHeaders: { 'X-Workspace': `\${${variable}}` },
    };
    try {
      process.env[variable] = 'first';
      const first = getMCPAppToolsPublicationGeneration(config);
      process.env[variable] = 'second';
      expect(getMCPAppToolsPublicationGeneration(config)).not.toBe(first);
      expect(config.requestHeaders).toEqual({ 'X-Workspace': `\${${variable}}` });
    } finally {
      if (original === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = original;
      }
    }
  });

  it('includes the resolved runtime environment in app publication generations', () => {
    const variable = 'LIBRECHAT_MCP_CATALOG_ORIGIN_TEST';
    const original = process.env[variable];
    const config: ParsedServerConfig = {
      type: 'streamable-http',
      url: `\${${variable}}/mcp`,
    };

    try {
      process.env[variable] = 'https://old.example.com';
      const oldGeneration = getMCPAppToolsPublicationGeneration(config);
      process.env[variable] = 'https://new.example.com';
      const newGeneration = getMCPAppToolsPublicationGeneration(config);

      expect(newGeneration).not.toBe(oldGeneration);
    } finally {
      if (original === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = original;
      }
    }
  });

  it('captures a connection-bound publication generation from the app layer', async () => {
    const generationHandler = jest.fn().mockResolvedValue('generation-a');
    setMCPToolsChangedGenerationHandler(generationHandler);

    await expect(
      getMCPToolsChangedGeneration({ userId: 'user-1', serverName: 'dynamic' }),
    ).resolves.toBe('generation-a');
    expect(generationHandler).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'dynamic',
    });
  });

  it('renews a current connection-bound publication generation through the app layer', async () => {
    const renewalHandler = jest.fn().mockResolvedValue(true);
    setMCPToolsChangedGenerationRenewalHandler(renewalHandler);
    const scope = {
      userId: 'user-1',
      serverName: 'dynamic',
      publicationGeneration: 'generation-a',
    };

    await expect(renewMCPToolsChangedGeneration(scope)).resolves.toBe(true);
    expect(renewalHandler).toHaveBeenCalledWith(scope);
  });

  it('reserves app revisions by runtime config and skips user scopes', async () => {
    const revisionHandler = jest.fn().mockResolvedValue('7');
    const serverConfig: ParsedServerConfig = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
    };
    setMCPToolsChangedRevisionHandler(revisionHandler);

    await expect(
      reserveMCPToolsChangedRevision({ serverName: 'dynamic', serverConfig }),
    ).resolves.toBe('7');
    await expect(
      reserveMCPToolsChangedRevision({ serverName: 'dynamic', serverConfig, userId: 'user-1' }),
    ).resolves.toBeUndefined();
    expect(revisionHandler).toHaveBeenCalledTimes(1);
    expect(revisionHandler).toHaveBeenCalledWith({
      serverName: 'dynamic',
      configGeneration: getMCPAppToolsPublicationGeneration(serverConfig),
    });
  });

  it('passes a complete server snapshot and user scope to the handler', async () => {
    const handler = jest.fn();
    const event = { ...createEvent(), userId: 'user-1' };
    setMCPToolsChangedHandler(handler);

    await notifyMCPToolsChanged(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('awaits an async handler before returning', async () => {
    let finished = false;
    setMCPToolsChangedHandler(async () => {
      await Promise.resolve();
      finished = true;
    });

    await notifyMCPToolsChanged(createEvent());

    expect(finished).toBe(true);
  });

  it('coalesces an in-flight burst and publishes the newest snapshot last', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const published: string[] = [];
    const handler = jest.fn(async (event: MCPToolsChangedEvent) => {
      published.push(event.tools[0].name);
      if (event.tools[0].name === 'one') {
        await firstBlocked;
      }
    });
    setMCPToolsChangedHandler(handler);

    const first = notifyMCPToolsChanged(createEvent('one'));
    await Promise.resolve();
    const second = notifyMCPToolsChanged(createEvent('two'));
    const third = notifyMCPToolsChanged(createEvent('three'));
    releaseFirst?.();
    await Promise.all([first, second, third]);

    expect(published).toEqual(['one', 'three']);
  });

  it('retries a failed cache publication without rejecting the notification handler', async () => {
    jest.useFakeTimers();
    const handler = jest
      .fn<Promise<void>, [MCPToolsChangedEvent]>()
      .mockRejectedValueOnce(new Error('Redis down'))
      .mockResolvedValue(undefined);
    setMCPToolsChangedHandler(handler);

    await expect(notifyMCPToolsChanged(createEvent())).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(250);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('stops dispatching when the handler is unregistered during an in-flight failure', async () => {
    let rejectPublication: ((error: Error) => void) | undefined;
    const publication = new Promise<void>((_, reject) => {
      rejectPublication = reject;
    });
    const handler = jest.fn(() => publication);
    setMCPToolsChangedHandler(handler);

    const notification = notifyMCPToolsChanged(createEvent());
    await Promise.resolve();
    setMCPToolsChangedHandler(null);
    rejectPublication?.(new Error('publisher shutting down'));

    await expect(notification).resolves.toBeUndefined();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued retry before cache invalidation', async () => {
    jest.useFakeTimers();
    const handler = jest.fn().mockRejectedValue(new Error('Redis down'));
    const event = { ...createEvent(), userId: 'user-1' };
    setMCPToolsChangedHandler(handler);

    await notifyMCPToolsChanged(event);
    await cancelMCPToolsChanged(event);
    await jest.advanceTimersByTimeAsync(30_000);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drains an in-flight publication before disconnect returns', async () => {
    let releasePublication: (() => void) | undefined;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const event = { ...createEvent(), userId: 'user-1' };
    setMCPToolsChangedHandler(() => publication);

    const notification = notifyMCPToolsChanged(event);
    await Promise.resolve();
    let drained = false;
    const cancellation = cancelMCPToolsChanged(event).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releasePublication?.();
    await Promise.all([notification, cancellation]);

    expect(drained).toBe(true);
  });

  it('does nothing when no handler is registered', async () => {
    await expect(notifyMCPToolsChanged(createEvent())).resolves.toBeUndefined();
  });
});
