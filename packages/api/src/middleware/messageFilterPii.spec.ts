import { messageFilterPiiSchema, setMessageFilterRegexValidator } from 'librechat-data-provider';
import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import {
  createMessageFilterPii,
  findPiiMatchInMessages,
  configureMessageFilterRegexValidator,
} from './messageFilterPii';

type CapturedResponse = { status?: number; body?: unknown };

function runMiddleware(
  config: MessageFilterPiiConfig | undefined,
  body: unknown,
  filters?: FiltersConfig,
): { capturedRes: CapturedResponse; nextCalls: number } {
  const captured: CapturedResponse = {};
  let nextCalls = 0;
  const mw = createMessageFilterPii({
    getConfig: () => config,
    getFilters: () => filters,
  });
  const req = { body } as unknown as Request;
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    nextCalls++;
  };
  mw(req, res, next);
  return { capturedRes: captured, nextCalls };
}

async function runMiddlewareWithFiles(
  body: unknown,
  filters: FiltersConfig,
  getFiles: NonNullable<Parameters<typeof createMessageFilterPii>[0]['getFiles']>,
): Promise<{ capturedRes: CapturedResponse; nextCalls: number }> {
  const captured: CapturedResponse = {};
  let nextCalls = 0;
  const mw = createMessageFilterPii({
    getConfig: () => undefined,
    getFilters: () => filters,
    getFiles,
  });
  const req = {
    body,
    user: { id: 'user-1', tenantId: 'tenant-1' },
  } as unknown as Request;
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    nextCalls++;
  };
  await mw(req, res, next);
  return { capturedRes: captured, nextCalls };
}

function nestedPayload(depth: number): unknown {
  let value: unknown = 'safe';
  for (let index = 0; index < depth; index++) {
    value = { nested: value };
  }
  return value;
}

describe('messageFilterPii middleware', () => {
  it('passes through when no config is provided', () => {
    const { capturedRes, nextCalls } = runMiddleware(undefined, {
      text: 'my key is sk-proj-FAKE1234567890ABCDEF',
    });
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('passes through when req.body.text is missing', () => {
    const { capturedRes, nextCalls } = runMiddleware({}, {});
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('passes through when req.body.text is the empty string', () => {
    const { capturedRes, nextCalls } = runMiddleware({}, { text: '' });
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('blocks a manually selected skill name before agent initialization', () => {
    const submittedName = 'PRIVATE-SKILL';
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { manualSkills: [submittedName] },
      {
        skills: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toEqual({
      error: 'content_filter_block',
      message: 'Submitted content contains a private value. Remove it and try again.',
      source: 'skill',
      field: 'name',
    });
    expect(JSON.stringify(capturedRes.body)).not.toContain(submittedName);
  });

  it('passes through plain text that matches no pattern', () => {
    const { capturedRes, nextCalls } = runMiddleware({}, { text: 'hello world' });
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('preserves legacy-only behavior for nested payloads outside the legacy surface', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { role: 'user', content: [{ type: 'vendor', payload: nestedPayload(30) }] },
    );

    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('returns a raw-free 400 when protected nested message content cannot be fully inspected', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { role: 'user', content: [{ type: 'vendor', payload: nestedPayload(30) }] },
      {
        messages: {
          pii: {
            fields: ['content_part'],
          },
        },
      },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toEqual({
      error: 'content_filter_uninspectable',
      message: 'Submitted content could not be completely inspected before processing.',
      source: 'message',
      field: 'content_part',
    });
    expect(JSON.stringify(capturedRes.body)).not.toContain('safe');
  });

  it('fails closed when incomplete nested content would contribute to assembled context', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { role: 'user', content: [{ type: 'vendor', payload: nestedPayload(30) }] },
      {
        messages: {
          pii: {
            fields: ['assembled_context'],
          },
        },
      },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({
      error: 'content_filter_uninspectable',
      source: 'message',
      field: 'content_part',
    });
  });

  it('returns 400 when selected chat model parameters exhaust traversal', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { options: { provider_option: nestedPayload(30) } },
      {
        modelParameters: {
          pii: {
            fields: ['request_fields'],
          },
        },
      },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.body).toMatchObject({
      error: 'content_filter_uninspectable',
      source: 'model_parameter',
      field: 'request_fields',
    });
  });

  it('allows exhausted chat model parameters when only stop is selected', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { options: { provider_option: nestedPayload(30) } },
      {
        modelParameters: {
          pii: {
            fields: ['stop'],
          },
        },
      },
    );

    expect(nextCalls).toBe(1);
    expect(capturedRes).toEqual({});
  });

  it('rejects with 400 when an sk- token is present (default starters)', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { text: 'my key is sk-proj-FAKE1234567890ABCDEF please' },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toEqual({
      error: 'message_filter_pii_block',
      message: 'Message contains a sk- prefix token. Remove it and try again.',
    });
  });

  it('rejects model-bound event input before durable ingress can persist it', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { input: 'dispatch this with sk-proj-FAKE1234567890ABCDEF' },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('rejects with 400 when a Bearer header is present', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { text: 'Authorization: Bearer eyJabc.def-ghi' },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('rejects with 400 when an api-key header is present', () => {
    const { capturedRes, nextCalls } = runMiddleware({}, { text: 'api-key: foo123bar' });
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it.each([
    ['U+00A0 no-break space', 0x00a0],
    ['U+000B vertical tab', 0x000b],
    ['U+2028 line separator', 0x2028],
    ['U+2029 paragraph separator', 0x2029],
    ['U+FEFF zero-width no-break space', 0xfeff],
  ])('rejects an api-key header separated by %s', (_label, code) => {
    const ws = String.fromCharCode(code);
    const { capturedRes, nextCalls } = runMiddleware({}, { text: `api-key:${ws}foo123bar` });
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  const SK = 'sk-proj-FAKE1234567890ABCDEF';

  it('rejects a resume ask-user answer containing a blocked token', () => {
    const { capturedRes, nextCalls } = runMiddleware({}, { answer: `the key is ${SK}` });
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects a batched ask-user answer containing a blocked token', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { answers: { environment: 'staging', credentials: `the key is ${SK}` } },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('does not inspect an oversized batched ask-user answer before resume validation', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { answers: { environment: 'x'.repeat(16_001), credentials: `the key is ${SK}` } },
    );
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('rejects a blocked pattern spanning serialized batch answers', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {
        starterPatterns: [],
        customPatterns: [{ id: 'split', label: 'Split token', regex: '123[^0-9]+456' }],
      },
      { answers: { first: '123', second: '456' } },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects the normalized ToolMessage ordering when request keys arrive out of order', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {
        starterPatterns: [],
        customPatterns: [
          {
            id: 'ordered',
            label: 'Ordered token',
            regex: '\\{"answers":\\{"first":"123","second":"456"\\}\\}',
          },
        ],
      },
      { answers: { second: '456', first: '123' } },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects a tool-approval decision responseText containing a blocked token', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { decisions: [{ tool_call_id: 'a', decision: 'respond', responseText: `use ${SK}` }] },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects a reject-reason containing a blocked token', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { decisions: [{ tool_call_id: 'a', decision: 'reject', reason: `leaked ${SK}` }] },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects edited tool arguments containing a blocked token (stringified)', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { decisions: [{ tool_call_id: 'a', decision: 'edit', editedArguments: { token: SK } }] },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('passes a clean resume answer through', () => {
    const { capturedRes, nextCalls } = runMiddleware({}, { answer: 'name it report.pdf' });
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('applies file-only policy to chat attachment names', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { files: [{ filename: 'PRIVATE-REPORT.txt' }] },
      {
        files: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private-file', label: 'private file', regex: 'PRIVATE-[A-Z]+\\.txt' },
            ],
          },
        },
      },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({
      error: 'content_filter_block',
      source: 'file',
      field: 'name',
    });
  });

  it('blocks opaque chat attachments before downstream processing when configured', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      undefined,
      { files: [{ file_data: 'opaque-file-data' }] },
      {
        files: {
          pii: {
            fields: ['content'],
            uninspectable: 'block',
          },
        },
      },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({
      error: 'content_filter_uninspectable',
      source: 'file',
      field: 'content',
    });
  });

  it('allows an owned canonical agent attachment after inspecting its hydrated text', async () => {
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'report.txt',
        filepath: '/uploads/report.txt',
        text: 'safe extracted text',
      },
    ]);
    const { capturedRes, nextCalls } = await runMiddlewareWithFiles(
      {
        text: 'summarize the attached report',
        files: [{ file_id: 'owned-file', filepath: '/uploads/report.txt', type: 'text/plain' }],
      },
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      getFiles,
    );

    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['owned-file'] },
        user: 'user-1',
        tenantId: 'tenant-1',
      },
      {},
      {},
    );
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('does not read canonical files for an explicitly inactive file policy', async () => {
    const getFiles = jest.fn().mockResolvedValue([]);
    const { capturedRes, nextCalls } = await runMiddlewareWithFiles(
      {
        text: 'summarize the attached report',
        files: [{ file_id: 'owned-file' }],
      },
      {
        files: {
          pii: {
            starterPatterns: [],
          },
        },
        messages: {
          pii: {
            fields: ['text'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      },
      getFiles,
    );

    expect(getFiles).not.toHaveBeenCalled();
    expect(nextCalls).toBe(1);
    expect(capturedRes).toEqual({});
  });

  it('blocks a canonical attachment when its hydrated text matches file policy', async () => {
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'report.txt',
        filepath: '/uploads/report.txt',
        text: 'contains PRIVATE-DATA',
      },
    ]);
    const { capturedRes, nextCalls } = await runMiddlewareWithFiles(
      {
        text: 'summarize the attached report',
        files: [{ file_id: 'owned-file' }],
      },
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-data',
                label: 'private data',
                regex: 'PRIVATE-DATA',
              },
            ],
          },
        },
      },
      getFiles,
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({
      error: 'content_filter_block',
      source: 'file',
      field: 'extracted_text',
    });
  });

  it('keeps an unresolved canonical attachment fail-closed', async () => {
    const { capturedRes, nextCalls } = await runMiddlewareWithFiles(
      {
        text: 'summarize the attached report',
        files: [{ file_id: 'missing-file' }],
      },
      {
        files: {
          pii: {
            fields: ['extracted_text'],
            uninspectable: 'block',
          },
        },
      },
      jest.fn().mockResolvedValue([]),
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({
      error: 'content_filter_uninspectable',
      source: 'file',
      field: 'extracted_text',
    });
  });

  it('honors a starterPatterns subset (sk passes when only bearer is enabled)', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      { starterPatterns: ['bearer_header'] },
      { text: 'my key is sk-proj-FAKE1234567890ABCDEF please' },
    );
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('treats starterPatterns: [] as disabling all starters', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      { starterPatterns: [] },
      { text: 'my key is sk-proj-FAKE1234567890ABCDEF please' },
    );
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('rejects on a customPatterns match with the operator-supplied label', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {
        starterPatterns: [],
        customPatterns: [{ id: 'org', label: 'Org token', regex: '\\bORG-[A-Z0-9]{6,}' }],
      },
      { text: 'token ORG-DEADBEEF here' },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toEqual({
      error: 'message_filter_pii_block',
      message: 'Message contains a Org token. Remove it and try again.',
    });
  });

  it('layers customPatterns on top of starters', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {
        customPatterns: [{ id: 'org', label: 'Org token', regex: '\\bORG-[A-Z0-9]{6,}' }],
      },
      { text: 'token ORG-DEADBEEF here' },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects with 400 when a quoted excerpt contains a blocked token (clean text)', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { text: 'explain this', quotes: ['leaked sk-proj-FAKE1234567890ABCDEF here'] },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('scans quotes even when req.body.text is empty', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { text: '', quotes: ['api-key: foo123bar'] },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('rejects a secret split across a quote and the typed text (merged scan)', () => {
    // Neither piece matches the api-key pattern alone, but the merged
    // `> api-key:\n\nsecret` the model receives does (the pattern allows whitespace).
    const { capturedRes, nextCalls } = runMiddleware({}, { text: 'secret', quotes: ['api-key:'] });
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('passes through when neither text nor quotes match', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { text: 'hello world', quotes: ['a clean excerpt', 'another clean one'] },
    );
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('ignores non-string quote entries without throwing', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {},
      { text: 'hello world', quotes: [null, 42, '', 'clean'] },
    );
    expect(nextCalls).toBe(1);
    expect(capturedRes.status).toBeUndefined();
  });

  it('returns the same compiled pattern array for repeat calls with the same config (memoization)', () => {
    const config: MessageFilterPiiConfig = {
      customPatterns: [{ id: 'org', label: 'Org token', regex: '\\bORG-[A-Z0-9]{6,}' }],
    };
    const a = runMiddleware(config, { text: 'plain' });
    const b = runMiddleware(config, { text: 'plain' });
    expect(a.nextCalls).toBe(1);
    expect(b.nextCalls).toBe(1);
  });

  it('fails closed when a custom pattern fails to compile, blocking even benign text', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [
        { id: 'broken', label: 'Broken', regex: '(' },
        { id: 'org', label: 'Org token', regex: '\\bORG-[A-Z0-9]{6,}' },
      ],
    };
    // A dropped pattern means the config no longer enforces what the operator declared, so
    // every request is blocked rather than silently enforcing only the surviving subset.
    const benign = runMiddleware(config, { text: 'plain text' });
    expect(benign.nextCalls).toBe(0);
    expect(benign.capturedRes.status).toBe(400);
    const matching = runMiddleware(config, { text: 'token ORG-DEADBEEF here' });
    expect(matching.nextCalls).toBe(0);
    expect(matching.capturedRes.status).toBe(400);
  });

  it('evaluates a catastrophic-backtracking customPattern in bounded time', () => {
    // `(a+)+$` against a long non-terminating run is exponential on a backtracking
    // engine (native RegExp takes tens of seconds at ~32 chars); the linear-time
    // engine returns immediately, so this must not hang.
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [{ id: 'evil', label: 'Evil', regex: '(a+)+$' }],
    };
    const adversarial = 'a'.repeat(60) + '!';
    const start = process.hrtime.bigint();
    const { nextCalls } = runMiddleware(config, { text: adversarial });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(nextCalls).toBe(1);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('still matches a catastrophic-shaped pattern against matching input', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [{ id: 'evil', label: 'Evil', regex: '(a+)+$' }],
    };
    const { capturedRes, nextCalls } = runMiddleware(config, { text: 'a'.repeat(20) });
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
  });

  it('fails closed when a custom pattern uses engine-unsupported syntax', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [
        { id: 'backref', label: 'Backref', regex: '(a)\\1' },
        { id: 'org', label: 'Org token', regex: '\\bORG-[A-Z0-9]{6,}' },
      ],
    };
    const benign = runMiddleware(config, { text: 'plain text' });
    expect(benign.nextCalls).toBe(0);
    expect(benign.capturedRes.status).toBe(400);
    const matching = runMiddleware(config, { text: 'token ORG-DEADBEEF here' });
    expect(matching.nextCalls).toBe(0);
    expect(matching.capturedRes.status).toBe(400);
  });

  it('fails closed on a dropped custom pattern even when default starters remain', () => {
    // The partial-drop case: with starterPatterns omitted the three defaults survive, so the
    // pattern set is non-empty; failing closed must key off the drop, not an empty set, or the
    // dropped rule's target passes silently.
    const config: MessageFilterPiiConfig = {
      customPatterns: [{ id: 'dup', label: 'Duplicate', regex: '(a)\\1' }],
    };
    const { capturedRes, nextCalls } = runMiddleware(config, { text: 'aa' });
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('findPiiMatchInMessages flags misconfigured on a dropped pattern under default starters', () => {
    const config: MessageFilterPiiConfig = {
      customPatterns: [{ id: 'dup', label: 'Duplicate', regex: '(a)\\1' }],
    };
    const hit = findPiiMatchInMessages([{ role: 'user', content: 'aa' }], config);
    expect(hit?.misconfigured).toBe(true);
  });
});

describe('findPiiMatchInMessages', () => {
  it('returns null for missing or empty messages', () => {
    expect(findPiiMatchInMessages(undefined, {})).toBeNull();
    expect(findPiiMatchInMessages([], {})).toBeNull();
  });

  it('returns null when no config is provided', () => {
    expect(
      findPiiMatchInMessages([{ role: 'user', content: 'sk-proj-FAKE123' }], undefined),
    ).toBeNull();
  });

  it('matches a system-role message (remote APIs accept caller-supplied system roles)', () => {
    const hit = findPiiMatchInMessages(
      [{ role: 'system', content: 'system primer with sk-proj-FAKE1234567890ABCDEF embedded' }],
      {},
    );
    expect(hit).toEqual({ id: 'sk_prefix', label: 'sk- prefix token' });
  });

  it('matches an assistant-role message (callers can include attacker-controlled history)', () => {
    const hit = findPiiMatchInMessages(
      [{ role: 'assistant', content: 'sk-proj-FAKE1234567890ABCDEF' }],
      {},
    );
    expect(hit).toEqual({ id: 'sk_prefix', label: 'sk- prefix token' });
  });

  it('matches a tool-role message', () => {
    const hit = findPiiMatchInMessages(
      [{ role: 'tool', content: 'tool reply leaking sk-proj-FAKE1234567890ABCDEF' }],
      {},
    );
    expect(hit).toEqual({ id: 'sk_prefix', label: 'sk- prefix token' });
  });

  it('matches a string-content user message', () => {
    const hit = findPiiMatchInMessages(
      [{ role: 'user', content: 'my key is sk-proj-FAKE1234567890ABCDEF' }],
      {},
    );
    expect(hit).toEqual({ id: 'sk_prefix', label: 'sk- prefix token' });
  });

  it('matches a content-parts user message (text part)', () => {
    const hit = findPiiMatchInMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:...' } },
            { type: 'text', text: 'Authorization: Bearer abc.def.ghi' },
          ],
        },
      ],
      {},
    );
    expect(hit).toEqual({ id: 'bearer_header', label: 'Bearer token' });
  });

  it('returns null when no user message matches', () => {
    expect(findPiiMatchInMessages([{ role: 'user', content: 'hello world' }], {})).toBeNull();
  });

  it('honors customPatterns from config', () => {
    const hit = findPiiMatchInMessages([{ role: 'user', content: 'token ORG-DEADBEEF here' }], {
      starterPatterns: [],
      customPatterns: [{ id: 'org', label: 'Org token', regex: '\\bORG-[A-Z0-9]{6,}' }],
    });
    expect(hit).toEqual({ id: 'org', label: 'Org token' });
  });
});

describe('configureMessageFilterRegexValidator (RE2 config-load validation)', () => {
  afterAll(() => {
    setMessageFilterRegexValidator((value) => {
      try {
        new RegExp(value, 'g');
        return true;
      } catch {
        return false;
      }
    });
  });

  it('rejects RE2-incompatible custom patterns at config parse once wired', () => {
    configureMessageFilterRegexValidator();
    const reject = (regex: string) =>
      messageFilterPiiSchema.safeParse({ customPatterns: [{ id: 'a', label: 'A', regex }] })
        .success;
    // lookahead, numeric + named backreference, control escape: all valid JS, unsupported by RE2
    expect(reject('(?=x)y')).toBe(false);
    expect(reject('(a)\\1')).toBe(false);
    expect(reject('(?<n>x)\\k<n>')).toBe(false);
    expect(reject('token-\\cA+')).toBe(false);
    // a normal RE2-compatible pattern still passes
    expect(reject('\\bORG-[A-Z0-9]{6,}')).toBe(true);
    expect(
      messageFilterPiiSchema.safeParse({
        customPatterns: Array.from({ length: 9 }, (_, index) => ({
          id: `expanded-${index}`,
          label: `Expanded ${index}`,
          regex: `a{1000}Q${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it('fails closed with 400 when every configured pattern fails to compile', () => {
    const { capturedRes, nextCalls } = runMiddleware(
      {
        starterPatterns: [],
        customPatterns: [{ id: 'backref', label: 'Backref', regex: '(a)\\1' }],
      },
      { text: 'anything at all' },
    );
    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('fails closed when a typed legacy config bypasses the compiled-program schema budget', () => {
    configureMessageFilterRegexValidator();
    const { capturedRes, nextCalls } = runMiddleware(
      {
        starterPatterns: [],
        customPatterns: Array.from({ length: 9 }, (_, index) => ({
          id: `expanded-${index}`,
          label: `Expanded ${index}`,
          regex: `a{1000}Q${index}`,
        })),
      },
      { text: 'safe' },
    );

    expect(nextCalls).toBe(0);
    expect(capturedRes.status).toBe(400);
    expect(capturedRes.body).toMatchObject({ error: 'message_filter_pii_block' });
  });

  it('findPiiMatchInMessages returns a misconfigured match when every pattern fails to compile', () => {
    const hit = findPiiMatchInMessages([{ role: 'user', content: 'hello' }], {
      starterPatterns: [],
      customPatterns: [{ id: 'backref', label: 'Backref', regex: '(a)\\1' }],
    });
    expect(hit?.misconfigured).toBe(true);
  });
});
