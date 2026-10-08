import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { ProtectionFinding, TextContentFragment } from '../protection/types';
import {
  contentFilterBlockResponse,
  contentFilterModelBoundBlockResponse,
  createContentFilter,
  getContentFilterError,
  isContentFilterError,
} from './contentFilter';
import {
  ContentTraversalLimitError,
  getContentTraversalFragments,
} from '../protection/adapters/nested';
import { extractAssistantContent, extractPresetContent } from '../protection/adapters/submissions';
import { ContentFilterInputTooLargeError, UninspectableFileError } from '../protection/files';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

function promptFragment(field: 'description' | 'instructions', text: string): TextContentFragment {
  return {
    id: `prompt.${field}`,
    path: `/prompt/${field}`,
    text,
    source: 'prompt',
    field,
    format: 'plain',
    treatment: 'replaceable',
    provenance: 'user',
  };
}

function runMiddleware(params: {
  filters?: FiltersConfig;
  legacyPii?: MessageFilterPiiConfig;
  opaqueFileInput?: unknown;
  body?: unknown;
  extract: jest.Mock<Iterable<TextContentFragment>, [Request]>;
}): {
  readonly captured: CapturedResponse;
  readonly next: jest.MockedFunction<NextFunction>;
} {
  const captured: CapturedResponse = {};
  const middleware = createContentFilter({
    getFilters: () => params.filters,
    getLegacyPii: () => params.legacyPii,
    getOpaqueFileInput:
      params.opaqueFileInput === undefined ? undefined : () => params.opaqueFileInput,
    extract: params.extract,
  });
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as Response;
  const next = jest.fn() as jest.MockedFunction<NextFunction>;

  middleware({ body: params.body ?? {} } as Request, response, next);
  return { captured, next };
}

function nestedValue(depth: number): unknown {
  let value: unknown = 'safe';
  for (let index = 0; index < depth; index++) {
    value = { nested: value };
  }
  return value;
}

describe('contentFilter middleware', () => {
  it('is default-off and does not extract request content without a configured rule', () => {
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => {
      throw new Error('content extraction should be bypassed');
    });

    const { captured, next } = runMiddleware({ extract });

    expect(extract).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('does not extract content for present but zero-rule configurations', () => {
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => {
      throw new Error('content extraction should be bypassed');
    });

    for (const config of [
      { filters: {} as FiltersConfig },
      {
        filters: {
          messages: { pii: { starterPatterns: [] } },
        } as FiltersConfig,
      },
      {
        legacyPii: { starterPatterns: [] },
      },
    ]) {
      const { captured, next } = runMiddleware({ ...config, extract });
      expect(next).toHaveBeenCalledTimes(1);
      expect(captured).toEqual({});
    }
    expect(extract).not.toHaveBeenCalled();
  });

  it('honors per-field selection and passes non-selected content through', () => {
    const filters: FiltersConfig = {
      prompts: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'org-token',
              label: 'organization token',
              regex: 'ORG-[A-Z]+',
            },
          ],
        },
      },
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => [
      promptFragment('description', 'ORG-SECRET'),
    ]);

    const { captured, next } = runMiddleware({ filters, extract });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('blocks selected content with field metadata but no submitted text or policy identifiers', () => {
    const secret = 'ORG-DO-NOT-ECHO';
    const filters: FiltersConfig = {
      prompts: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'internal-policy-id',
              label: 'organization token',
              regex: 'ORG-[A-Z-]+',
            },
          ],
        },
      },
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => [
      promptFragment('instructions', secret),
    ]);

    const { captured, next } = runMiddleware({ filters, extract });

    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({
      error: 'content_filter_block',
      message: 'Submitted content contains a organization token. Remove it and try again.',
      source: 'prompt',
      field: 'instructions',
    });
    expect(JSON.stringify(captured.body)).not.toContain(secret);
    expect(captured.body).not.toHaveProperty('detectorId');
    expect(captured.body).not.toHaveProperty('ruleId');
  });

  it('builds the same metadata-only public shape from a finding', () => {
    const response = contentFilterBlockResponse({
      detectorId: 'pii-pattern',
      ruleId: 'private-rule',
      label: 'protected value',
      source: 'tool_argument',
      field: 'arguments',
      provenance: 'user',
      fragmentId: 'fragment-containing-ORG-SECRET',
      fragmentPath: '/arguments',
    });

    expect(response).toEqual({
      error: 'content_filter_block',
      message: 'Submitted content contains a protected value. Remove it and try again.',
      source: 'tool_argument',
      field: 'arguments',
    });
    expect(JSON.stringify(response)).not.toContain('ORG-SECRET');
    expect(JSON.stringify(response)).not.toContain('private-rule');
  });

  it.each([
    ['Bearer token', 'bearer_header'],
    ['api-key header', 'api_key_header'],
  ])('builds a stable model-bound response without the %s detector label', (label, ruleId) => {
    const finding: ProtectionFinding = {
      detectorId: 'pii-pattern',
      ruleId,
      label,
      source: 'tool_argument',
      field: 'output',
      provenance: 'tool',
      fragmentId: 'tool.output',
      fragmentPath: '/output',
    };
    const response = contentFilterModelBoundBlockResponse(finding);

    expect(response).toEqual({
      error: 'content_filter_block',
      message: 'Submitted content was blocked by content policy.',
      source: 'tool_argument',
      field: 'output',
    });
    expect(JSON.stringify(response)).not.toContain(label);
    expect(JSON.stringify(response)).not.toContain(ruleId);
  });

  it('blocks opaque stored-message input before textual extraction', () => {
    const opaqueValue = 'data:image/png;base64,DO-NOT-ECHO';
    const filters = {
      files: {
        pii: {
          fields: ['content'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => {
      throw new Error('text extraction should not run after an opaque block');
    });

    const { captured, next } = runMiddleware({
      filters,
      opaqueFileInput: {
        content: [{ type: 'image_url', image_url: { url: opaqueValue } }],
      },
      extract,
    });

    expect(extract).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(captured).toEqual({
      status: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'content',
      },
    });
    expect(JSON.stringify(captured.body)).not.toContain(opaqueValue);
  });

  it('allows opaque media when only an unrelated file field is selected', () => {
    const filters = {
      files: {
        pii: {
          fields: ['name'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => []);

    const { captured, next } = runMiddleware({
      filters,
      opaqueFileInput: {
        content: [{ type: 'image_url', image_url: 'https://example.test/submitted-image.png' }],
      },
      extract,
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('hydrates an owned canonical file before filtering a stored-message mutation', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } as FiltersConfig;
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'report.txt',
        filepath: '/uploads/report.txt',
        text: 'safe extracted text',
      },
    ]);
    const captured: CapturedResponse = {};
    const middleware = createContentFilter({
      getFilters: () => filters,
      getOpaqueFileInput: (req) => req.body,
      getFiles,
      extract: () => [],
    });
    const response = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as Response;
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    await middleware(
      {
        body: { files: [{ file_id: 'owned-file' }] },
        user: { id: 'user-1', tenantId: 'tenant-1' },
      } as unknown as Request,
      response,
      next,
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
    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('does not read canonical files for an explicitly inactive file policy', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          starterPatterns: [],
        },
      },
      prompts: {
        pii: {
          fields: ['instructions'],
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
    };
    const getFiles = jest.fn().mockResolvedValue([]);
    const captured: CapturedResponse = {};
    const middleware = createContentFilter({
      getFilters: () => filters,
      getOpaqueFileInput: (req) => req.body,
      getFiles,
      extract: () => [],
    });
    const response = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as Response;
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    await middleware(
      {
        body: { files: [{ file_id: 'owned-file' }] },
        user: { id: 'user-1', tenantId: 'tenant-1' },
      } as unknown as Request,
      response,
      next,
    );

    expect(getFiles).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('classifies the raw-free opaque error for existing import error handling', () => {
    expect(isContentFilterError(new UninspectableFileError('content'))).toBe(true);
    expect(getContentFilterError(new ContentFilterInputTooLargeError('content'))).toMatchObject({
      statusCode: 413,
    });
    expect(isContentFilterError(new ContentTraversalLimitError())).toBe(true);
    const policyError = new UninspectableFileError('transcript');
    const wrapped = new Error('wrapped', { cause: policyError });
    expect(getContentFilterError(wrapped)).toBe(policyError);
    const fragment: TextContentFragment = {
      id: 'secret',
      path: '/secret',
      text: 'DO-NOT-SERIALIZE',
      source: 'message',
      field: 'content_part',
      format: 'plain',
      treatment: 'replaceable',
      provenance: 'user',
    };
    const error = new ContentTraversalLimitError([fragment]);
    expect(error).not.toHaveProperty('fragments');
    expect(JSON.stringify(error)).not.toContain('DO-NOT-SERIALIZE');
    expect(getContentTraversalFragments(error)).toEqual([fragment]);
  });

  it('fails closed with a raw-free response when nested inspection exhausts its budget', () => {
    const filters = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'nested-secret',
              label: 'nested secret',
              regex: 'NESTED-SECRET',
            },
          ],
        },
      },
    } as FiltersConfig;
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => {
      throw new ContentTraversalLimitError();
    });

    const { captured, next } = runMiddleware({ filters, extract });

    expect(next).not.toHaveBeenCalled();
    expect(captured).toEqual({
      status: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'message',
        field: 'content_part',
      },
    });
  });

  it('preserves field granularity for an exhausted unselected nested field', () => {
    const filters = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
        },
      },
    } as FiltersConfig;
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => {
      throw new ContentTraversalLimitError();
    });

    const { captured, next } = runMiddleware({ filters, extract });

    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('fails closed when selected model request fields exceed the traversal budget', () => {
    const filters: FiltersConfig = {
      modelParameters: {
        pii: {
          fields: ['request_fields'],
        },
      },
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>((req) =>
      extractPresetContent(req.body),
    );

    const { captured, next } = runMiddleware({
      filters,
      body: { options: { provider_option: nestedValue(30) } },
      extract,
    });

    expect(next).not.toHaveBeenCalled();
    expect(captured).toEqual({
      status: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'model_parameter',
        field: 'request_fields',
      },
    });
  });

  it('allows traversal exhaustion from an unselected model parameter field', () => {
    const filters: FiltersConfig = {
      modelParameters: {
        pii: {
          fields: ['stop'],
        },
      },
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>((req) =>
      extractPresetContent(req.body),
    );

    const { captured, next } = runMiddleware({
      filters,
      body: { options: { provider_option: nestedValue(30) } },
      extract,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(captured).toEqual({});
  });

  it('still inspects hydrated canonical files when unrelated traversal is exhausted', async () => {
    const secret = 'PRIVATE-CANONICAL-FILE';
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-file',
              label: 'private file value',
              regex: 'PRIVATE-CANONICAL-FILE',
            },
          ],
        },
      },
    } as FiltersConfig;
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'report.txt',
        text: secret,
      },
    ]);
    const captured: CapturedResponse = {};
    const middleware = createContentFilter({
      getFilters: () => filters,
      getOpaqueFileInput: (req) => req.body,
      getFiles,
      extract: () => {
        throw new ContentTraversalLimitError(
          [],
          [{ source: 'model_parameter', fields: ['request_fields'] }],
        );
      },
    });
    const response = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as Response;
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    await middleware(
      {
        body: { files: [{ file_id: 'owned-file' }] },
        user: { id: 'user-1' },
      } as unknown as Request,
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(captured).toEqual({
      status: 400,
      body: {
        error: 'content_filter_block',
        message: 'Submitted content contains a private file value. Remove it and try again.',
        source: 'file',
        field: 'extracted_text',
      },
    });
    expect(JSON.stringify(captured.body)).not.toContain(secret);
  });

  it('still blocks earlier prompt content when unrelated model traversal is exhausted', () => {
    const filters: FiltersConfig = {
      prompts: {
        pii: {
          fields: ['instructions'],
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
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>((req) =>
      extractPresetContent(req.body),
    );

    const { captured, next } = runMiddleware({
      filters,
      body: {
        instructions: 'Previously submitted PRIVATE-PROMPT',
        options: { provider_option: nestedValue(30) },
      },
      extract,
    });

    expect(next).not.toHaveBeenCalled();
    expect(captured.body).toMatchObject({
      error: 'content_filter_block',
      source: 'prompt',
      field: 'instructions',
    });
  });

  it('still blocks later assistant tools when unrelated model traversal is exhausted', () => {
    const filters: FiltersConfig = {
      agentInstructions: {
        pii: {
          fields: ['description'],
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
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>((req) =>
      extractAssistantContent(req.body),
    );

    const { captured, next } = runMiddleware({
      filters,
      body: {
        options: { provider_option: nestedValue(30) },
        tools: [
          {
            type: 'function',
            function: {
              name: 'submit_record',
              description: 'Previously submitted PRIVATE-TOOL',
            },
          },
        ],
      },
      extract,
    });

    expect(next).not.toHaveBeenCalled();
    expect(captured.body).toMatchObject({
      error: 'content_filter_block',
      source: 'agent_instruction',
      field: 'description',
    });
  });

  it('still inspects known partial fragments before handling traversal exhaustion', () => {
    const filters = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'partial-secret',
              label: 'partial secret',
              regex: 'PARTIAL-SECRET',
            },
          ],
        },
      },
    } as FiltersConfig;
    const partialFragment: TextContentFragment = {
      id: 'message.text',
      path: '/text',
      text: 'PARTIAL-SECRET',
      source: 'message',
      field: 'text',
      format: 'plain',
      treatment: 'replaceable',
      provenance: 'user',
    };
    const extract = jest.fn<Iterable<TextContentFragment>, [Request]>(() => {
      throw new ContentTraversalLimitError([partialFragment]);
    });

    const { captured, next } = runMiddleware({ filters, extract });

    expect(next).not.toHaveBeenCalled();
    expect(captured).toMatchObject({
      status: 400,
      body: {
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      },
    });
  });
});
