import type { FiltersConfig } from 'librechat-data-provider';
import type { ExternalChatMessage, ExternalMessagePart, ExternalToolCall } from './messages';
import {
  ContentTraversalLimitError,
  getContentTraversalScopes,
  isNestedMessageTraversalProtected,
} from './nested';
import { extractMessageContent, snapshotExternalMessages } from './messages';
import { inspectContent } from '../runtime';

describe('extractMessageContent', () => {
  it('treats every caller-supplied role as user provenance', () => {
    const fragments = Array.from(
      extractMessageContent([
        { role: 'system', content: 'system text' },
        { role: 'assistant', content: 'assistant text' },
        { role: 'tool', content: 'tool text' },
        { role: 'user', content: 'user text' },
      ]),
    );

    expect(
      fragments.map(({ text, provenance, source, field }) => ({
        text,
        provenance,
        source,
        field,
      })),
    ).toEqual([
      { text: 'system text', provenance: 'user', source: 'message', field: 'text' },
      {
        text: 'system text',
        provenance: 'user',
        source: 'agent_instruction',
        field: 'instructions',
      },
      { text: 'assistant text', provenance: 'user', source: 'message', field: 'text' },
      { text: 'tool text', provenance: 'user', source: 'message', field: 'text' },
      { text: 'tool text', provenance: 'user', source: 'tool_argument', field: 'output' },
      { text: 'user text', provenance: 'user', source: 'message', field: 'text' },
    ]);
  });

  it('lets instruction policy independently protect system and developer messages', () => {
    const filters: FiltersConfig = {
      agentInstructions: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'submitted-content',
              label: 'submitted content',
              regex: 'BLOCK-[A-Z]+',
            },
          ],
        },
      },
    };

    expect(
      inspectContent(
        extractMessageContent([
          { role: 'user', content: 'BLOCK-USER' },
          { role: 'system', content: 'BLOCK-SYSTEM' },
        ]),
        { filters },
      ),
    ).toMatchObject({
      source: 'agent_instruction',
      field: 'instructions',
      fragmentPath: '/1/content',
    });
    expect(
      inspectContent(
        extractMessageContent([
          {
            role: 'developer',
            content: [{ type: 'text', text: 'BLOCK-DEVELOPER' }],
          },
        ]),
        { filters },
      ),
    ).toMatchObject({
      source: 'agent_instruction',
      field: 'instructions',
      fragmentPath: '/0/content/0/text',
    });
  });

  it('extracts caller-supplied message names as message content', () => {
    expect(Array.from(extractMessageContent([{ role: 'user', name: 'submitted name' }]))).toEqual([
      {
        id: 'external-message.0.name',
        path: '/0/name',
        text: 'submitted name',
        source: 'message',
        field: 'name',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
    ]);
  });

  it('extracts every text-bearing content part without trusting its declared type', () => {
    const fragments = Array.from(
      extractMessageContent([
        {
          role: 'user',
          content: [
            { type: 'image_url' },
            { type: 'image_url', text: 'text on a non-text part' },
            { type: 'text', text: 'ordinary text part' },
            null,
          ],
        },
      ]),
    );

    expect(fragments).toEqual([
      {
        id: 'external-message.0.part.1',
        path: '/0/content/1/text',
        text: 'text on a non-text part',
        source: 'message',
        field: 'content_part',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'external-message.0.part.2',
        path: '/0/content/2/text',
        text: 'ordinary text part',
        source: 'message',
        field: 'content_part',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      },
      {
        id: 'external-message.0.assembled',
        path: '/0/content',
        text: 'text on a non-text partordinary text part',
        source: 'assembled_context',
        field: 'assembled_context',
        format: 'plain',
        treatment: 'inspect_only',
        provenance: 'user',
      },
    ]);
  });

  it('extracts file references and tool-call fields without inspecting data payloads', () => {
    const dataUri = `data:image/png;base64,${'a'.repeat(1024)}`;
    const fragments = Array.from(
      extractMessageContent([
        {
          content: [
            { type: 'image_url', image_url: { url: dataUri } },
            { type: 'image_url', image_url: 'https://example.test/image.png?token=ORG-REF' },
            { type: 'file', file_id: 'file-ORG-ID' },
            { type: 'file', filename: 'ORG-report.txt' },
            {
              type: 'file',
              file: { file_id: 'file-ORG-NESTED', filename: 'ORG-nested.txt' },
            },
          ],
          tool_calls: [{ function: { name: 'ORG-TOOL', arguments: '{"token":"ORG-ARGS"}' } }],
        },
      ]),
    );

    expect(
      fragments.map(({ text, source, field, format }) => ({ text, source, field, format })),
    ).toEqual([
      {
        text: 'https://example.test/image.png?token=ORG-REF',
        source: 'message',
        field: 'attachment_reference',
        format: 'uri',
      },
      {
        text: 'https://example.test/image.png?token=ORG-REF',
        source: 'file',
        field: 'uri',
        format: 'uri',
      },
      {
        text: 'file-ORG-ID',
        source: 'message',
        field: 'attachment_reference',
        format: 'plain',
      },
      {
        text: 'ORG-report.txt',
        source: 'message',
        field: 'attachment_reference',
        format: 'plain',
      },
      {
        text: 'ORG-report.txt',
        source: 'file',
        field: 'name',
        format: 'plain',
      },
      {
        text: 'file-ORG-NESTED',
        source: 'message',
        field: 'attachment_reference',
        format: 'plain',
      },
      {
        text: 'ORG-nested.txt',
        source: 'message',
        field: 'attachment_reference',
        format: 'plain',
      },
      {
        text: 'ORG-nested.txt',
        source: 'file',
        field: 'name',
        format: 'plain',
      },
      {
        text: 'ORG-TOOL',
        source: 'tool_argument',
        field: 'name',
        format: 'plain',
      },
      {
        text: '{"token":"ORG-ARGS"}',
        source: 'tool_argument',
        field: 'arguments',
        format: 'json',
      },
    ]);
    expect(fragments.some(({ text }) => text.includes(dataUri))).toBe(false);
  });

  it('dual-routes provider-native URLs as file URIs and message attachment references', () => {
    const sharedUri = 'https://example.test/shared.png?token=ORG-SHARED';
    const dataUri = 'data:image/png;base64,ORG-OPAQUE';
    const fragments = Array.from(
      extractMessageContent([
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image_url: sharedUri,
              source: { type: 'url', data: sharedUri },
            },
            {
              type: 'document',
              source: { type: 'url', data: 'https://example.test/ORG-DOCUMENT.pdf' },
            },
            { type: 'image', source: { type: 'base64', data: 'ORG-BINARY' } },
            { type: 'document', source: { type: 'url', data: dataUri } },
            { type: 'document', source_type: 'text', text: dataUri },
          ],
        },
      ]),
    );

    expect(
      fragments.filter(({ text, field }) => text === sharedUri && field === 'attachment_reference'),
    ).toHaveLength(1);
    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/0/content/1/source/data',
          text: 'https://example.test/ORG-DOCUMENT.pdf',
          source: 'message',
          field: 'attachment_reference',
          format: 'uri',
        }),
        expect.objectContaining({
          path: '/0/content/1/source/data',
          text: 'https://example.test/ORG-DOCUMENT.pdf',
          source: 'file',
          field: 'uri',
          format: 'uri',
        }),
      ]),
    );
    expect(
      fragments.some(({ text }) => text.includes('ORG-BINARY') || text.includes('ORG-OPAQUE')),
    ).toBe(false);

    const customPatterns = [
      {
        id: 'provider-url',
        label: 'provider URL',
        regex: 'ORG-DOCUMENT',
      },
    ];
    expect(
      inspectContent(fragments, {
        filters: {
          files: { pii: { fields: ['uri'], starterPatterns: [], customPatterns } },
        },
      }),
    ).toMatchObject({
      source: 'file',
      field: 'uri',
      fragmentPath: '/0/content/1/source/data',
    });
    expect(
      inspectContent(fragments, {
        filters: {
          messages: {
            pii: { fields: ['attachment_reference'], starterPatterns: [], customPatterns },
          },
        },
      }),
    ).toMatchObject({
      source: 'message',
      field: 'attachment_reference',
      fragmentPath: '/0/content/1/source/data',
    });
  });

  it('routes inline provider documents through file and message content policies', () => {
    const fragments = Array.from(
      extractMessageContent([
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'text', data: 'ANTHROPIC-CONTENT' },
            },
            {
              type: 'document',
              source_type: 'text',
              text: 'LANGCHAIN-EXTRACTED',
            },
          ],
        },
      ]),
    );

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/0/content/0/source/data',
          text: 'ANTHROPIC-CONTENT',
          source: 'message',
          field: 'content_part',
        }),
        expect.objectContaining({
          path: '/0/content/0/source/data',
          text: 'ANTHROPIC-CONTENT',
          source: 'file',
          field: 'content',
        }),
        expect.objectContaining({
          path: '/0/content/1/text',
          text: 'LANGCHAIN-EXTRACTED',
          source: 'message',
          field: 'content_part',
        }),
        expect.objectContaining({
          path: '/0/content/1/text',
          text: 'LANGCHAIN-EXTRACTED',
          source: 'file',
          field: 'extracted_text',
        }),
        expect.objectContaining({
          text: 'ANTHROPIC-CONTENTLANGCHAIN-EXTRACTED',
          source: 'assembled_context',
          field: 'assembled_context',
        }),
      ]),
    );
    expect(
      fragments.filter(
        ({ path, source, field }) =>
          path === '/0/content/0/source/data' && source === 'message' && field === 'content_part',
      ),
    ).toHaveLength(1);
    expect(fragments.some(({ field }) => field === 'attachment_reference')).toBe(false);

    expect(
      inspectContent(fragments, {
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'inline-content',
                  label: 'inline content',
                  regex: 'ANTHROPIC-CONTENT',
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      source: 'file',
      field: 'content',
      fragmentPath: '/0/content/0/source/data',
    });
    expect(
      inspectContent(fragments, {
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'inline-extracted',
                  label: 'inline extracted text',
                  regex: 'LANGCHAIN-EXTRACTED',
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      source: 'file',
      field: 'extracted_text',
      fragmentPath: '/0/content/1/text',
    });
  });

  it('retains traversal fail-close for unclassified provider source fields', () => {
    const content = [
      {
        type: 'document',
        source: {
          type: 'url',
          data: 'https://example.test/document.pdf',
          metadata: Array.from({ length: 5000 }, (_, index) => `submitted-${index}`),
        },
      },
    ];

    expect(() => Array.from(extractMessageContent([{ role: 'user', content }]))).toThrow(
      ContentTraversalLimitError,
    );
  });

  it('extracts unknown nested textual leaves without rescanning structural or encoded payloads', () => {
    const cyclicPart: { type: string; payload: unknown; self?: unknown } = {
      type: 'vendor_content',
      payload: {
        'ORG-SECRET': false,
        source: {
          type: 'json',
          description: 'nested submitted description',
          data: 'ordinary submitted data',
        },
        encoded: {
          type: 'base64',
          data: 'encoded-payload-must-not-be-treated-as-text',
        },
        image: 'data:image/png;base64,opaque-image-data',
      },
    };
    cyclicPart.self = cyclicPart;

    const fragments = Array.from(extractMessageContent([{ role: 'user', content: [cyclicPart] }]));

    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          path: '/0/content/0/payload/ORG-SECRET',
          text: 'ORG-SECRET',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          path: '/0/content/0/payload/source/description',
          text: 'nested submitted description',
        }),
        expect.objectContaining({
          source: 'message',
          field: 'content_part',
          path: '/0/content/0/payload/source/data',
          text: 'ordinary submitted data',
        }),
      ]),
    );
    expect(fragments.some(({ text }) => text.includes('encoded-payload'))).toBe(false);
    expect(fragments.some(({ text }) => text.includes('opaque-image-data'))).toBe(false);
    expect(fragments.some(({ text }) => text === 'vendor_content')).toBe(false);
  });

  it('fails closed instead of silently truncating an oversized nested part', () => {
    const content = [
      {
        type: 'vendor_content',
        payload: Array.from({ length: 5000 }, (_, index) => `submitted-${index}`),
      },
    ];

    expect(() => Array.from(extractMessageContent([{ role: 'user', content }]))).toThrow(
      ContentTraversalLimitError,
    );
  });

  it('yields inspected-prefix findings before enforcing a deferred traversal failure', () => {
    const payload = Array.from({ length: 5000 }, (_, index) =>
      index === 0 ? 'BLOCK-FIRST' : `submitted-${index}`,
    );

    expect(
      inspectContent(
        extractMessageContent([{ role: 'user', content: [{ type: 'vendor_content', payload }] }]),
        {
          filters: {
            messages: {
              pii: {
                fields: ['content_part'],
                starterPatterns: [],
                customPatterns: [{ id: 'first', label: 'first', regex: 'BLOCK-FIRST' }],
              },
            },
          },
        },
      ),
    ).toMatchObject({
      source: 'message',
      field: 'content_part',
      label: 'first',
      fragmentPath: '/0/content/0/payload/0',
    });
  });

  it('fails closed when a nested value cannot be enumerated', () => {
    let ownKeyReads = 0;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          ownKeyReads++;
          throw new Error('blocked enumeration');
        },
      },
    );

    expect(() =>
      Array.from(
        extractMessageContent([
          {
            role: 'user',
            content: [{ type: 'vendor_content', payload: hostile }],
          },
        ]),
      ),
    ).toThrow(ContentTraversalLimitError);
    expect(ownKeyReads).toBe(0);
  });

  it('shares one traversal budget across parts and bounds aggregate fragment work', () => {
    let carrierReads = 0;
    const carrier = new Proxy(new Array<string>(3500), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          carrierReads++;
          return `submitted-${property}`;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const content = Array.from({ length: 512 }, () => ({ payload: carrier }));
    const fragments = [];
    let traversalError: unknown;

    try {
      for (const fragment of extractMessageContent([{ role: 'user', content }])) {
        fragments.push(fragment);
      }
    } catch (error) {
      traversalError = error;
    }

    expect(traversalError).toBeInstanceOf(ContentTraversalLimitError);
    expect(carrierReads).toBeLessThanOrEqual(4200);
    expect(fragments.length).toBeLessThanOrEqual(4100);
  });

  it('bounds assembled-context copies across the full extraction callback', () => {
    const first = 'A'.repeat(1024 * 1024);
    const second = 'B'.repeat(1024 * 1024);
    const messages = Array.from({ length: 128 }, () => ({
      role: 'user',
      content: [{ text: first }, { text: second }],
    }));
    let assembledCharacters = 0;
    let traversalError: unknown;

    try {
      for (const fragment of extractMessageContent(messages)) {
        if (fragment.source === 'assembled_context') {
          assembledCharacters += fragment.text.length;
        }
      }
    } catch (error) {
      traversalError = error;
    }

    expect(traversalError).toBeInstanceOf(ContentTraversalLimitError);
    expect(assembledCharacters).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(getContentTraversalScopes(traversalError as ContentTraversalLimitError)).toEqual([
      { source: 'assembled_context', fields: ['assembled_context'] },
    ]);
  });

  it('bounds a sparse ten-million-item generic carrier before numeric expansion', () => {
    let lengthReads = 0;
    let numericReads = 0;
    const carrier = new Proxy(new Array<string>(10_000_000), {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
        } else if (typeof property === 'string' && /^\d+$/.test(property)) {
          numericReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      Array.from(
        extractMessageContent([
          { role: 'user', content: [{ type: 'vendor_content', payload: carrier }] },
        ]),
      ),
    ).toThrow(ContentTraversalLimitError);
    expect(lengthReads).toBe(1);
    expect(numericReads).toBeLessThanOrEqual(4200);
  });

  it.each(['messages', 'content', 'tool_calls'] as const)(
    'captures and caps the %s array without dispatching its iterator',
    (arrayKind) => {
      let iteratorReads = 0;
      let lengthReads = 0;
      let numericReads = 0;
      const carrier = new Proxy(new Array<unknown>(10_000_000), {
        get(target, property, receiver) {
          if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('submitted iterator must not run');
          }
          if (property === 'length') {
            lengthReads++;
          } else if (typeof property === 'string' && /^\d+$/.test(property)) {
            numericReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const messages =
        arrayKind === 'messages'
          ? (carrier as readonly ExternalChatMessage[])
          : [
              arrayKind === 'content'
                ? ({ content: carrier } as ExternalChatMessage)
                : ({ tool_calls: carrier } as ExternalChatMessage),
            ];

      expect(() => Array.from(extractMessageContent(messages))).toThrow(ContentTraversalLimitError);
      expect(iteratorReads).toBe(0);
      expect(lengthReads).toBe(1);
      expect(numericReads).toBe(4096);
    },
  );

  it('accepts 4,096 nested leaves and rejects 4,097', () => {
    expect(() =>
      Array.from(
        extractMessageContent([
          {
            role: 'user',
            content: [{ payload: Array.from({ length: 4096 }, () => 'submitted') }],
          },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      Array.from(
        extractMessageContent([
          {
            role: 'user',
            content: [{ payload: Array.from({ length: 4097 }, () => 'submitted') }],
          },
        ]),
      ),
    ).toThrow(ContentTraversalLimitError);
  });

  it('captures mutable provider and generic properties once and retains their first values', () => {
    let textReads = 0;
    let imageReads = 0;
    let imageUrlReads = 0;
    let secretReads = 0;
    const image = {} as { readonly url?: string };
    Object.defineProperty(image, 'url', {
      enumerable: true,
      get() {
        imageUrlReads++;
        return imageUrlReads === 1 ? 'https://example.test/PRIVATE-IMAGE' : 'safe-image';
      },
    });
    const payload = {} as { readonly secret?: string };
    Object.defineProperty(payload, 'secret', {
      enumerable: true,
      get() {
        secretReads++;
        return secretReads === 1 ? 'PRIVATE-GENERIC' : 'safe-generic';
      },
    });
    const part = { type: 'vendor_content', payload } as ExternalMessagePart;
    Object.defineProperty(part, 'text', {
      enumerable: true,
      get() {
        textReads++;
        return textReads === 1 ? 'PRIVATE-TEXT' : 'safe-text';
      },
    });
    Object.defineProperty(part, 'image_url', {
      enumerable: true,
      get() {
        imageReads++;
        return imageReads === 1 ? image : 'safe-image';
      },
    });

    const fragments = Array.from(extractMessageContent([{ role: 'user', content: [part] }]));

    expect({ textReads, imageReads, imageUrlReads, secretReads }).toEqual({
      textReads: 1,
      imageReads: 1,
      imageUrlReads: 1,
      secretReads: 1,
    });
    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/0/content/0/text', text: 'PRIVATE-TEXT' }),
        expect.objectContaining({
          path: '/0/content/0/image_url',
          text: 'https://example.test/PRIVATE-IMAGE',
        }),
        expect.objectContaining({
          path: '/0/content/0/payload/secret',
          text: 'PRIVATE-GENERIC',
        }),
      ]),
    );
    expect(fragments.some(({ text }) => text.startsWith('safe-'))).toBe(false);
  });

  it('captures mutable message, content-array, and tool-call fields exactly once', () => {
    let contentReads = 0;
    let contentLengthReads = 0;
    let contentItemReads = 0;
    let toolCallsReads = 0;
    let toolCallLengthReads = 0;
    let toolCallItemReads = 0;
    let functionReads = 0;
    let nameReads = 0;
    let argumentReads = 0;
    const content = new Proxy([{ text: 'PRIVATE-CONTENT' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          contentLengthReads++;
        } else if (property === '0') {
          contentItemReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fn = {} as { readonly name?: string; readonly arguments?: string };
    Object.defineProperties(fn, {
      name: {
        enumerable: true,
        get() {
          nameReads++;
          return nameReads === 1 ? 'PRIVATE-TOOL' : 'safe-tool';
        },
      },
      arguments: {
        enumerable: true,
        get() {
          argumentReads++;
          return argumentReads === 1 ? '{"token":"PRIVATE-ARGS"}' : '{}';
        },
      },
    });
    const toolCall = {} as ExternalToolCall;
    Object.defineProperty(toolCall, 'function', {
      enumerable: true,
      get() {
        functionReads++;
        return fn;
      },
    });
    const toolCalls = new Proxy([toolCall], {
      get(target, property, receiver) {
        if (property === 'length') {
          toolCallLengthReads++;
        } else if (property === '0') {
          toolCallItemReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const message = { role: 'user' } as ExternalChatMessage;
    Object.defineProperties(message, {
      content: {
        enumerable: true,
        get() {
          contentReads++;
          return content;
        },
      },
      tool_calls: {
        enumerable: true,
        get() {
          toolCallsReads++;
          return toolCalls;
        },
      },
    });

    const fragments = Array.from(extractMessageContent([message]));

    expect({
      contentReads,
      contentLengthReads,
      contentItemReads,
      toolCallsReads,
      toolCallLengthReads,
      toolCallItemReads,
      functionReads,
      nameReads,
      argumentReads,
    }).toEqual({
      contentReads: 1,
      contentLengthReads: 1,
      contentItemReads: 1,
      toolCallsReads: 1,
      toolCallLengthReads: 1,
      toolCallItemReads: 1,
      functionReads: 1,
      nameReads: 1,
      argumentReads: 1,
    });
    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'PRIVATE-CONTENT', source: 'message' }),
        expect.objectContaining({ text: 'PRIVATE-TOOL', field: 'name' }),
        expect.objectContaining({ text: '{"token":"PRIVATE-ARGS"}', field: 'arguments' }),
      ]),
    );
  });

  it('reuses one frozen snapshot for file-locator and text inspection', () => {
    let contentReads = 0;
    let textReads = 0;
    let fileIdReads = 0;
    const part = {} as ExternalMessagePart;
    Object.defineProperties(part, {
      text: {
        enumerable: true,
        get() {
          textReads++;
          return textReads === 1 ? 'PRIVATE-TEXT' : 'safe-text';
        },
      },
      file_id: {
        enumerable: true,
        get() {
          fileIdReads++;
          return fileIdReads === 1 ? 'file-PRIVATE' : 'file-safe';
        },
      },
    });
    const message = { role: 'user' } as ExternalChatMessage;
    Object.defineProperty(message, 'content', {
      enumerable: true,
      get() {
        contentReads++;
        return contentReads === 1 ? [part] : [{ text: 'safe-content', file_id: 'file-safe' }];
      },
    });

    const prepared = snapshotExternalMessages([message]);
    const preparedPart = prepared.messages[0]?.content?.[0] as ExternalMessagePart;
    expect(Object.isFrozen(prepared.messages)).toBe(true);
    expect(Object.isFrozen(preparedPart)).toBe(true);
    expect(preparedPart.file_id).toBe('file-PRIVATE');

    const fragments = Array.from(extractMessageContent(prepared));

    expect({ contentReads, textReads, fileIdReads }).toEqual({
      contentReads: 1,
      textReads: 1,
      fileIdReads: 1,
    });
    expect(fragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'PRIVATE-TEXT', field: 'content_part' }),
        expect.objectContaining({ text: 'file-PRIVATE', field: 'attachment_reference' }),
      ]),
    );
    expect(fragments.some(({ text }) => text.includes('safe-'))).toBe(false);
  });

  it('scopes incomplete submitted snapshots to every opaque audio surface', () => {
    let payload: unknown = { input_audio: { data: 'opaque-audio', format: 'mp3' } };
    for (let depth = 0; depth < 30; depth++) {
      payload = { nested: payload };
    }

    const prepared = snapshotExternalMessages([
      { role: 'user', content: [{ type: 'vendor_content', payload }] },
    ]);

    expect(prepared.traversalError).toBeInstanceOf(ContentTraversalLimitError);
    expect(
      getContentTraversalScopes(prepared.traversalError as ContentTraversalLimitError),
    ).toEqual(
      expect.arrayContaining([
        {
          source: 'file',
          fields: ['name', 'uri', 'content', 'extracted_text', 'transcript'],
        },
      ]),
    );
  });

  it('fails closed when prepared-brand detection receives a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    expect(() =>
      Array.from(
        extractMessageContent(
          proxy as unknown as readonly (ExternalChatMessage | null | undefined)[],
        ),
      ),
    ).toThrow(ContentTraversalLimitError);
  });

  it('applies traversal fail-close only to selected semantic fields', () => {
    expect(
      isNestedMessageTraversalProtected({
        filters: {
          messages: { pii: { fields: ['text'], starterPatterns: [] } },
        },
      }),
    ).toBe(false);
    expect(
      isNestedMessageTraversalProtected({
        filters: {
          messages: { pii: { fields: ['content_part'], starterPatterns: [] } },
        },
      }),
    ).toBe(false);
    expect(
      isNestedMessageTraversalProtected({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'active', label: 'active', regex: 'ACTIVE' }],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      isNestedMessageTraversalProtected({
        filters: {
          agentInstructions: { pii: { fields: ['instructions'] } },
        },
        roles: ['system'],
      }),
    ).toBe(true);
    expect(
      isNestedMessageTraversalProtected({
        filters: {
          toolArguments: { pii: { fields: ['output'], starterPatterns: ['sk_prefix'] } },
        },
        roles: ['tool'],
      }),
    ).toBe(true);
  });

  it('inspects model-equivalent text assembled across adjacent content parts', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['assembled_context'],
          starterPatterns: [],
          customPatterns: [{ id: 'split-token', label: 'split token', regex: 'sk-SECRET' }],
        },
      },
    };

    const finding = inspectContent(
      extractMessageContent([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'sk-' },
            { type: 'text', text: 'SECRET' },
          ],
        },
      ]),
      { filters },
    );

    expect(finding).toMatchObject({
      source: 'assembled_context',
      field: 'assembled_context',
      label: 'split token',
    });
  });
});
