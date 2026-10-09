import type { RunLLMConfig } from '~/types';
import { mediaTypeEssence, mergeHeaders, resolveConfigHeaders } from './headers';

describe('mediaTypeEssence', () => {
  it('returns the bare type for a header with no parameters', () => {
    expect(mediaTypeEssence('text/event-stream')).toBe('text/event-stream');
  });

  it('strips parameters', () => {
    expect(mediaTypeEssence('text/event-stream; charset=utf-8')).toBe('text/event-stream');
    expect(mediaTypeEssence('application/json;charset=utf-8')).toBe('application/json');
  });

  it('lowercases the type', () => {
    expect(mediaTypeEssence('TEXT/EVENT-STREAM')).toBe('text/event-stream');
    expect(mediaTypeEssence('Application/JSON; Charset=UTF-8')).toBe('application/json');
  });

  it('trims surrounding whitespace', () => {
    expect(mediaTypeEssence('  text/plain  ; charset=utf-8')).toBe('text/plain');
  });

  it('does not match a type named only inside a parameter', () => {
    expect(mediaTypeEssence('text/plain; boundary=text/event-stream')).toBe('text/plain');
    expect(mediaTypeEssence('text/plain; x=application/json')).toBe('text/plain');
  });

  it('returns an empty string for absent or empty headers', () => {
    expect(mediaTypeEssence(undefined)).toBe('');
    expect(mediaTypeEssence(null)).toBe('');
    expect(mediaTypeEssence('')).toBe('');
    expect(mediaTypeEssence('   ')).toBe('');
  });
});

describe('mergeHeaders', () => {
  it('returns undefined when neither side has headers', () => {
    expect(mergeHeaders(undefined, undefined)).toBeUndefined();
  });

  it('returns a copy of the side that is present', () => {
    expect(mergeHeaders({ a: '1' }, undefined)).toEqual({ a: '1' });
    expect(mergeHeaders(undefined, { b: '2' })).toEqual({ b: '2' });
  });

  it('lets override win on key collisions', () => {
    expect(mergeHeaders({ a: 'base', b: 'base' }, { b: 'override' })).toEqual({
      a: 'base',
      b: 'override',
    });
  });

  it('comma-unions anthropic-beta values from both sides (deduped)', () => {
    const merged = mergeHeaders(
      { 'anthropic-beta': 'custom-beta, shared' },
      { 'anthropic-beta': 'shared,managed-beta' },
    );
    expect(merged?.['anthropic-beta']).toBe('custom-beta,shared,managed-beta');
  });

  it('does not mutate the input objects', () => {
    const base = { a: '1' };
    const override = { b: '2' };
    mergeHeaders(base, override);
    expect(base).toEqual({ a: '1' });
    expect(override).toEqual({ b: '2' });
  });

  it('replaces a case-variant base key with the override (no duplicate header names)', () => {
    const merged = mergeHeaders({ authorization: 'custom' }, { Authorization: 'Bearer managed' });
    expect(merged).toEqual({ Authorization: 'Bearer managed' });
  });

  it('unions anthropic-beta case-insensitively, keeping the override casing', () => {
    const merged = mergeHeaders(
      { 'anthropic-beta': 'custom-beta' },
      { 'Anthropic-Beta': 'managed-beta' },
    );
    expect(merged).toEqual({ 'Anthropic-Beta': 'custom-beta,managed-beta' });
  });
});

describe('resolveConfigHeaders', () => {
  const user = { id: 'user-123', email: 'person@example.com' };
  const body = { conversationId: 'convo-abc' };

  it('is a no-op when llmConfig is null/undefined', () => {
    expect(() => resolveConfigHeaders({ llmConfig: null, user, body })).not.toThrow();
    expect(() => resolveConfigHeaders({ llmConfig: undefined, user, body })).not.toThrow();
  });

  it('resolves OpenAI-style configuration.defaultHeaders', () => {
    const llmConfig = {
      configuration: {
        defaultHeaders: {
          'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        },
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({
      'X-Conversation-Id': 'convo-abc',
      'X-User-Id': 'user-123',
    });
  });

  it('resolves Anthropic-style clientOptions.defaultHeaders while preserving non-placeholder values', () => {
    const llmConfig = {
      clientOptions: {
        defaultHeaders: {
          'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
          'cf-aig-metadata': '{"conversation_id":"{{LIBRECHAT_BODY_CONVERSATIONID}}"}',
        },
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, body });

    const clientOptions = (
      llmConfig as unknown as { clientOptions: { defaultHeaders: Record<string, string> } }
    ).clientOptions;
    expect(clientOptions.defaultHeaders).toEqual({
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'cf-aig-metadata': '{"conversation_id":"convo-abc"}',
    });
  });

  it('resolves only tenant placeholders in Google customHeaders', () => {
    const llmConfig = {
      customHeaders: {
        'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-Tenant-Id': '{{LIBRECHAT_USER_TENANT_ID}}',
        Authorization: 'Bearer ${SOME_KEY}',
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, tenantId: 'request-tenant', body });

    // Native Google headers are otherwise resolved in initializeGoogle. In
    // particular, provider auth must never pass through environment expansion.
    expect(
      (llmConfig as unknown as { customHeaders: Record<string, string> }).customHeaders,
    ).toEqual({
      'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      'X-Tenant-Id': 'request-tenant',
      Authorization: 'Bearer ${SOME_KEY}',
    });
  });

  it('resolves each header map only once across repeated calls (idempotent under reuse)', () => {
    process.env.HEADERS_SPEC_IDEMPOTENT = 'env-value';
    const reusedUser = { id: 'u', name: '${HEADERS_SPEC_IDEMPOTENT}' };
    const llmConfig = {
      configuration: { defaultHeaders: { 'X-Name': '{{LIBRECHAT_USER_NAME}}' } },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user: reusedUser, body });
    // Second pass must NOT re-expand the now-substituted ${...} from the user name
    resolveConfigHeaders({ llmConfig, user: reusedUser, body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({
      'X-Name': '${HEADERS_SPEC_IDEMPOTENT}',
    });
    delete process.env.HEADERS_SPEC_IDEMPOTENT;
  });

  it('resolves env-var placeholders in header values', () => {
    process.env.HEADERS_SPEC_GATEWAY_KEY = 'secret-key';
    const llmConfig = {
      configuration: {
        defaultHeaders: { 'X-Gateway-Key': '${HEADERS_SPEC_GATEWAY_KEY}' },
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({ 'X-Gateway-Key': 'secret-key' });
    delete process.env.HEADERS_SPEC_GATEWAY_KEY;
  });

  it('resolves model tenant aliases without exposing tenantId through the safe user', () => {
    const llmConfig = {
      configuration: {
        defaultHeaders: {
          'X-Tenant-ID': '{{LIBRECHAT_USER_TENANT_ID}}',
          'X-Canonical-Tenant-ID': '{{LIBRECHAT_USER_TENANTID}}',
        },
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, tenantId: 'request-tenant', body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({
      'X-Tenant-ID': 'request-tenant',
      'X-Canonical-Tenant-ID': 'request-tenant',
    });
  });

  it('blanks model tenant placeholders when the run has no tenant', () => {
    const llmConfig = {
      configuration: {
        defaultHeaders: { 'X-Tenant-ID': '{{LIBRECHAT_USER_TENANT_ID}}' },
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({ 'X-Tenant-ID': '' });
  });

  it('leaves configs without header maps untouched', () => {
    const llmConfig = { model: 'gpt-4o', configuration: {} } as unknown as RunLLMConfig;
    expect(() => resolveConfigHeaders({ llmConfig, user, body })).not.toThrow();
    expect(llmConfig.configuration).toEqual({});
  });

  it('never forwards unresolved user placeholders when user context is missing (issue #14580)', () => {
    const llmConfig = {
      configuration: {
        defaultHeaders: {
          'X-LibreChat-User': '{{LIBRECHAT_USER_OPENIDID}}',
          'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        },
      },
    } as unknown as RunLLMConfig;

    // The empty safe user produced by createSafeUser(undefined) — e.g. a disposed
    // req racing async title generation — must not leak literal template text.
    resolveConfigHeaders({ llmConfig, user: {} as { id: string }, body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({
      'X-LibreChat-User': '',
      'X-Conversation-Id': 'convo-abc',
    });
  });

  it('strips placeholders for fields the resolved user lacks', () => {
    const llmConfig = {
      configuration: {
        defaultHeaders: { 'X-LibreChat-User': '{{LIBRECHAT_USER_OPENIDID}}' },
      },
    } as unknown as RunLLMConfig;

    resolveConfigHeaders({ llmConfig, user, body });

    expect(llmConfig.configuration?.defaultHeaders).toEqual({ 'X-LibreChat-User': '' });
  });
});
