/**
 * Tests for collected usage functionality in GenerationJobManager.
 *
 * This tests the storage and retrieval of collectedUsage for abort handling,
 * ensuring all models (including parallel agents from addedConvo) have their
 * tokens spent when a conversation is aborted.
 */

import type { UsageMetadata } from '../interfaces/IJobStore';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

describe('CollectedUsage - InMemoryJobStore', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('should store and retrieve collectedUsage', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore();
    await store.initialize();

    const streamId = 'test-stream-1';
    await store.createJob(streamId, 'user-1');

    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
    ];

    store.setCollectedUsage(streamId, collectedUsage);
    const retrieved = store.getCollectedUsage(streamId);

    expect(retrieved).toEqual(collectedUsage);
    expect(retrieved).toHaveLength(2);

    await store.destroy();
  });

  it('should return empty array when no collectedUsage set', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore();
    await store.initialize();

    const streamId = 'test-stream-2';
    await store.createJob(streamId, 'user-1');

    const retrieved = store.getCollectedUsage(streamId);

    expect(retrieved).toEqual([]);

    await store.destroy();
  });

  it('should return empty array for non-existent stream', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore();
    await store.initialize();

    const retrieved = store.getCollectedUsage('non-existent-stream');

    expect(retrieved).toEqual([]);

    await store.destroy();
  });

  it('should update collectedUsage when set multiple times', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore();
    await store.initialize();

    const streamId = 'test-stream-3';
    await store.createJob(streamId, 'user-1');

    const usage1: UsageMetadata[] = [{ input_tokens: 100, output_tokens: 50, model: 'gpt-4' }];
    store.setCollectedUsage(streamId, usage1);

    // Simulate more usage being added
    const usage2: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
    ];
    store.setCollectedUsage(streamId, usage2);

    const retrieved = store.getCollectedUsage(streamId);
    expect(retrieved).toHaveLength(2);

    await store.destroy();
  });

  it('should clear collectedUsage when clearContentState is called', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore();
    await store.initialize();

    const streamId = 'test-stream-4';
    await store.createJob(streamId, 'user-1');

    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
    ];
    store.setCollectedUsage(streamId, collectedUsage);

    expect(store.getCollectedUsage(streamId)).toHaveLength(1);

    store.clearContentState(streamId);

    expect(store.getCollectedUsage(streamId)).toEqual([]);

    await store.destroy();
  });

  it('should clear collectedUsage when job is deleted', async () => {
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const store = new InMemoryJobStore();
    await store.initialize();

    const streamId = 'test-stream-5';
    await store.createJob(streamId, 'user-1');

    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
    ];
    store.setCollectedUsage(streamId, collectedUsage);

    await store.deleteJob(streamId);

    expect(store.getCollectedUsage(streamId)).toEqual([]);

    await store.destroy();
  });
});

describe('CollectedUsage - GenerationJobManager', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('should set and retrieve collectedUsage through manager', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `manager-test-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
    ];

    GenerationJobManager.setCollectedUsage(streamId, collectedUsage);

    // Retrieve through abort
    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.collectedUsage).toEqual(collectedUsage);
    expect(abortResult.collectedUsage).toHaveLength(2);

    await GenerationJobManager.destroy();
  });

  it('should return empty collectedUsage when none set', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `no-usage-test-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.collectedUsage).toEqual([]);

    await GenerationJobManager.destroy();
  });

  it('should not set collectedUsage if job does not exist', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });

    GenerationJobManager.initialize();

    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
    ];

    // This should not throw, just silently do nothing
    GenerationJobManager.setCollectedUsage('non-existent-stream', collectedUsage);

    const abortResult = await GenerationJobManager.abortJob('non-existent-stream');
    expect(abortResult.success).toBe(false);

    await GenerationJobManager.destroy();
  });
});

describe('AbortJob - Text and CollectedUsage', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('should extract text from content parts on abort', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `text-extract-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    // Set content parts with text
    const contentParts = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world!' },
    ];
    GenerationJobManager.setContentParts(streamId, contentParts as never);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.text).toBe('Hello world!');
    expect(abortResult.success).toBe(true);

    await GenerationJobManager.destroy();
  });

  it('should return empty text when no content parts', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `empty-text-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.text).toBe('');

    await GenerationJobManager.destroy();
  });

  it('should treat OAuth-only content as an early abort', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `oauth-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    GenerationJobManager.setContentParts(streamId, [
      {
        type: 'tool_call',
        tool_call: {
          type: 'tool_call',
          id: 'oauth-call-1',
          name: 'oauth_mcp_Google-Workspace',
          args: '',
          auth: 'https://auth.example.com/oauth',
        },
      },
    ] as never);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.success).toBe(true);
    expect(abortResult.content).toEqual([]);
    expect(abortResult.text).toBe('');
    expect(abortResult.finalEvent).toEqual(
      expect.objectContaining({
        earlyAbort: true,
        responseMessage: null,
      }),
    );

    await GenerationJobManager.destroy();
  });

  it('should keep post-created OAuth-only aborts tied to the created turn', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `created-oauth-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.updateMetadata(streamId, {
      responseMessageId: 'response-message-1',
      endpoint: 'agents',
      iconURL: 'https://example.com/spec-icon.png',
      model: 'gpt-4.1',
      userMessage: {
        messageId: 'user-message-1',
        parentMessageId: 'parent-message-1',
        conversationId: streamId,
        text: 'Use Google Workspace',
      },
    });
    await GenerationJobManager.emitChunk(streamId, {
      created: true,
      streamId,
      message: {
        messageId: 'user-message-1',
        parentMessageId: 'parent-message-1',
        conversationId: streamId,
        text: 'Use Google Workspace',
        sender: 'User',
        isCreatedByUser: true,
      },
    });

    GenerationJobManager.setContentParts(streamId, [
      {
        type: 'tool_call',
        tool_call: {
          type: 'tool_call',
          id: 'oauth-call-1',
          name: 'oauth_mcp_Google-Workspace',
          args: '',
          auth: 'https://auth.example.com/oauth',
        },
      },
    ] as never);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.success).toBe(true);
    expect(abortResult.content).toEqual([]);
    expect(abortResult.text).toBe('');
    expect(abortResult.finalEvent).toEqual(
      expect.objectContaining({
        earlyAbort: false,
        conversation: { conversationId: streamId },
        requestMessage: expect.objectContaining({
          messageId: 'user-message-1',
        }),
        responseMessage: expect.objectContaining({
          messageId: 'response-message-1',
          content: [],
          endpoint: 'agents',
          iconURL: 'https://example.com/spec-icon.png',
          model: 'gpt-4.1',
        }),
      }),
    );

    await GenerationJobManager.destroy();
  });

  it('should strip OAuth prompts but persist real abort content', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `mixed-oauth-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');
    await GenerationJobManager.updateMetadata(streamId, {
      responseMessageId: 'response-message-1',
      userMessage: {
        messageId: 'user-message-1',
        parentMessageId: 'parent-message-1',
        conversationId: streamId,
        text: 'Use Google Workspace',
      },
    });

    const textPart = { type: 'text', text: 'Partial response...' };
    GenerationJobManager.setContentParts(streamId, [
      {
        type: 'tool_call',
        tool_call: {
          type: 'tool_call',
          id: 'oauth-call-1',
          name: 'oauth_mcp_Google-Workspace',
          args: '',
          auth: 'https://auth.example.com/oauth',
        },
      },
      textPart,
    ] as never);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.success).toBe(true);
    expect(abortResult.content).toEqual([textPart]);
    expect(abortResult.text).toBe('Partial response...');
    expect(abortResult.finalEvent).toEqual(
      expect.objectContaining({
        earlyAbort: false,
        responseMessage: expect.objectContaining({
          content: [textPart],
        }),
      }),
    );

    await GenerationJobManager.destroy();
  });

  it('should return both text and collectedUsage on abort', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `full-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    // Set content parts
    const contentParts = [{ type: 'text', text: 'Partial response...' }];
    GenerationJobManager.setContentParts(streamId, contentParts as never);

    // Set collected usage
    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
      { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
    ];
    GenerationJobManager.setCollectedUsage(streamId, collectedUsage);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.success).toBe(true);
    expect(abortResult.text).toBe('Partial response...');
    expect(abortResult.collectedUsage).toEqual(collectedUsage);
    expect(abortResult.content).toHaveLength(1);

    await GenerationJobManager.destroy();
  });

  it('should return empty values for non-existent job', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });

    GenerationJobManager.initialize();

    const abortResult = await GenerationJobManager.abortJob('non-existent-job');

    expect(abortResult.success).toBe(false);
    expect(abortResult.text).toBe('');
    expect(abortResult.collectedUsage).toEqual([]);
    expect(abortResult.content).toEqual([]);
    expect(abortResult.jobData).toBeNull();

    await GenerationJobManager.destroy();
  });
});

describe('Real-world Scenarios', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('should handle parallel agent abort with collected usage', async () => {
    /**
     * Scenario: User aborts a conversation with addedConvo (parallel agents)
     * - Primary agent: gemini-3-flash-preview
     * - Parallel agent: gpt-5.2
     * Both should have their tokens spent on abort
     */
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `parallel-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    // Simulate content from primary agent
    const contentParts = [
      { type: 'text', text: 'Primary agent output...' },
      { type: 'text', text: 'More content...' },
    ];
    GenerationJobManager.setContentParts(streamId, contentParts as never);

    // Simulate collected usage from both agents (as would happen during generation)
    const collectedUsage: UsageMetadata[] = [
      {
        input_tokens: 31596,
        output_tokens: 151,
        model: 'gemini-3-flash-preview',
      },
      {
        input_tokens: 28000,
        output_tokens: 120,
        model: 'gpt-5.2',
      },
    ];
    GenerationJobManager.setCollectedUsage(streamId, collectedUsage);

    // Abort the job
    const abortResult = await GenerationJobManager.abortJob(streamId);

    // Verify both models' usage is returned
    expect(abortResult.success).toBe(true);
    expect(abortResult.collectedUsage).toHaveLength(2);
    expect(abortResult.collectedUsage[0].model).toBe('gemini-3-flash-preview');
    expect(abortResult.collectedUsage[1].model).toBe('gpt-5.2');

    // Verify text is extracted
    expect(abortResult.text).toContain('Primary agent output');

    await GenerationJobManager.destroy();
  });

  it('should handle abort with cache tokens from Anthropic', async () => {
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `cache-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    // Anthropic-style cache tokens
    const collectedUsage: UsageMetadata[] = [
      {
        input_tokens: 788,
        output_tokens: 163,
        cache_creation_input_tokens: 30808,
        cache_read_input_tokens: 0,
        model: 'claude-opus-4-5-20251101',
      },
    ];
    GenerationJobManager.setCollectedUsage(streamId, collectedUsage);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.collectedUsage[0].cache_creation_input_tokens).toBe(30808);

    await GenerationJobManager.destroy();
  });

  it('should handle abort with sequential tool calls usage', async () => {
    /**
     * Scenario: Single agent with multiple tool calls, aborted mid-execution
     * Usage accumulates for each LLM call
     */
    const { GenerationJobManager } = await import('../GenerationJobManager');
    const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
    const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });

    GenerationJobManager.initialize();

    const streamId = `sequential-abort-${Date.now()}`;
    await GenerationJobManager.createJob(streamId, 'user-1');

    // Usage from multiple sequential LLM calls (tool use pattern)
    const collectedUsage: UsageMetadata[] = [
      { input_tokens: 100, output_tokens: 50, model: 'gpt-4' }, // Initial call
      { input_tokens: 150, output_tokens: 30, model: 'gpt-4' }, // After tool result 1
      { input_tokens: 180, output_tokens: 20, model: 'gpt-4' }, // After tool result 2 (aborted here)
    ];
    GenerationJobManager.setCollectedUsage(streamId, collectedUsage);

    const abortResult = await GenerationJobManager.abortJob(streamId);

    expect(abortResult.collectedUsage).toHaveLength(3);
    // All three entries should be present for proper token accounting

    await GenerationJobManager.destroy();
  });
});
