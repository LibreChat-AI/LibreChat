import { Constants } from 'librechat-data-provider';
import type { ChatGptConversation, ImportedAsset } from '~/import/types';
import { convertConversation } from './convert';

const CITE = '';

function conversation(mapping: ChatGptConversation['mapping']): ChatGptConversation {
  return {
    conversation_id: 'ext-1',
    title: 'Trip planning',
    create_time: 1700000000,
    update_time: 1700000100,
    default_model_slug: 'gpt-5-thinking',
    is_archived: true,
    is_starred: true,
    pinned_time: null,
    mapping,
  };
}

const OPTIONS = {
  userId: 'u1',
  assets: new Map<string, ImportedAsset>(),
  defaultModel: 'gpt-4o',
};

describe('convertConversation', () => {
  it('carries archive, pin, and external id onto the conversation, on the configured model', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'user', name: null },
            create_time: 1700000001,
            content: { content_type: 'text', parts: ['hi'] },
          },
          parent: 'root',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(result.isArchived).toBe(true);
    expect(result.pinned).toBe(true);
    /** Not `default_model_slug` ('gpt-5-thinking'): the conversation's model is
     * what its next prompt is sent with, and a historical ChatGPT slug is not a
     * model any endpoint serves. */
    expect(result.model).toBe('gpt-4o');
    expect(result.externalId).toBe('ext-1');
    expect(result.title).toBe('Trip planning');
  });

  it('links children to parents and skips system messages transparently', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['sys'] },
        sys: {
          id: 'sys',
          message: {
            id: 'sys',
            author: { role: 'system', name: null },
            create_time: 1700000001,
            content: { content_type: 'text', parts: [''] },
          },
          parent: 'root',
          children: ['u'],
        },
        u: {
          id: 'u',
          message: {
            id: 'u',
            author: { role: 'user', name: null },
            create_time: 1700000002,
            content: { content_type: 'text', parts: ['question'] },
          },
          parent: 'sys',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('question');
    expect(result.messages[0].parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('folds thoughts into the answer as a think part and drops the recap', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['t'] },
        t: {
          id: 't',
          message: {
            id: 't',
            author: { role: 'assistant', name: null },
            create_time: 1700000002,
            content: {
              content_type: 'thoughts',
              thoughts: [{ content: 'Weighing options', summary: 'Deciding' }],
            },
          },
          parent: 'root',
          children: ['r'],
        },
        r: {
          id: 'r',
          message: {
            id: 'r',
            author: { role: 'assistant', name: null },
            create_time: 1700000003,
            content: { content_type: 'reasoning_recap', content: 'Thought for 7 seconds' },
          },
          parent: 't',
          children: ['a'],
        },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'assistant', name: null },
            create_time: 1700000004,
            content: { content_type: 'text', parts: ['Here is the answer'] },
            metadata: { model_slug: 'gpt-5-thinking' },
          },
          parent: 'r',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(result.messages).toHaveLength(1);
    const [answer] = result.messages;
    expect(answer.sender).toBe('GPT-5 Thinking');
    expect(answer.content).toEqual([
      { type: 'think', think: 'Weighing options' },
      { type: 'text', text: 'Here is the answer' },
    ]);
  });

  it('attaches rebuilt citations to the assistant message', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'assistant', name: null },
            create_time: 1700000002,
            content: { content_type: 'text', parts: [`Answer.${CITE}turn0search0`] },
            metadata: {
              model_slug: 'gpt-4o',
              content_references: [
                { type: 'webpage', alt: null, url: 'https://a.com', title: 'A', snippet: null },
              ],
            },
          },
          parent: 'root',
          children: [],
        },
      }),
      OPTIONS,
    );

    const [answer] = result.messages;
    expect(answer.attachments).toHaveLength(1);
    expect(answer.attachments?.[0].type).toBe('web_search');
    expect(answer.attachments?.[0].web_search.turn).toBe(0);
  });

  it('gives a cited assistant message content even with no thinking, so citations resolve', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'assistant', name: null },
            create_time: 1700000002,
            content: { content_type: 'text', parts: [`Answer.${CITE}turn0search0`] },
            metadata: {
              model_slug: 'gpt-4o',
              content_references: [
                { type: 'webpage', alt: null, url: 'https://a.com', title: 'A', snippet: null },
              ],
            },
          },
          parent: 'root',
          children: [],
        },
      }),
      OPTIONS,
    );

    const [answer] = result.messages;
    expect(answer.content).toEqual([{ type: 'text', text: answer.text }]);
  });

  it('leaves a plain assistant message without content, on the renderer it already used', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'assistant', name: null },
            create_time: 1700000002,
            content: { content_type: 'text', parts: ['Just prose.'] },
            metadata: { model_slug: 'gpt-4o' },
          },
          parent: 'root',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(result.messages[0].content).toBeUndefined();
    expect(result.messages[0].text).toBe('Just prose.');
  });

  it('emits a nested image_file content part for an assistant image, not just message.files', () => {
    const asset: ImportedAsset = {
      file_id: 'file-9',
      filepath: '/uploads/file-9.png',
      filename: 'coast.png',
      type: 'image/png',
      width: 1024,
      height: 1536,
    };
    const assets = new Map<string, ImportedAsset>([['sediment://file_gen', asset]]);

    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'assistant', name: null },
            create_time: 1700000002,
            content: {
              content_type: 'multimodal_text',
              parts: [
                'Here it is.',
                { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_gen' },
              ],
            },
            metadata: { model_slug: 'gpt-4o' },
          },
          parent: 'root',
          children: [],
        },
      }),
      { ...OPTIONS, assets },
    );

    const [answer] = result.messages;
    expect(answer.content).toEqual([
      { type: 'text', text: 'Here it is.' },
      { type: 'image_file', image_file: asset },
    ]);
    expect(answer.files).toEqual([asset]);
  });

  it('keeps a non-image assistant asset on message.files with no content part', () => {
    const asset: ImportedAsset = {
      file_id: 'file-8',
      filepath: '/uploads/file-8.wav',
      filename: 'reply.wav',
      type: 'audio/wav',
    };
    const assets = new Map<string, ImportedAsset>([['sediment://file_audio', asset]]);

    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'assistant', name: null },
            create_time: 1700000002,
            content: {
              content_type: 'multimodal_text',
              parts: [
                { content_type: 'audio_transcription', text: 'Spoken reply', direction: 'out' },
                { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_audio' },
              ],
            },
            metadata: { model_slug: 'gpt-4o' },
          },
          parent: 'root',
          children: [],
        },
      }),
      { ...OPTIONS, assets },
    );

    const [answer] = result.messages;
    expect(answer.content).toBeUndefined();
    expect(answer.files).toEqual([asset]);
  });

  it('reports asset pointers for later ingestion', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'user', name: null },
            create_time: 1700000002,
            content: {
              content_type: 'multimodal_text',
              parts: [
                { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-A' },
                'what is this',
              ],
            },
          },
          parent: 'root',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(result.messages[0].assetPointers).toEqual(['file-service://file-A']);
  });

  it('resolves a matching asset pointer onto message.files', () => {
    const asset: ImportedAsset = {
      file_id: 'file-1',
      filepath: '/uploads/file-1.png',
      filename: 'file-A.png',
      type: 'image/png',
    };
    const assets = new Map<string, ImportedAsset>([['file-service://file-A', asset]]);

    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'user', name: null },
            create_time: 1700000002,
            content: {
              content_type: 'multimodal_text',
              parts: [
                { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-A' },
                'what is this',
              ],
            },
          },
          parent: 'root',
          children: [],
        },
      }),
      { ...OPTIONS, assets },
    );

    expect(result.messages[0].files).toEqual([asset]);
  });

  it('survives a parent cycle without hanging', () => {
    const result = convertConversation(
      conversation({
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'user', name: null },
            create_time: 1700000001,
            content: { content_type: 'text', parts: ['one'] },
          },
          parent: 'b',
          children: [],
        },
        b: {
          id: 'b',
          message: {
            id: 'b',
            author: { role: 'user', name: null },
            create_time: 1700000002,
            content: { content_type: 'text', parts: ['two'] },
          },
          parent: 'a',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(result.messages).toHaveLength(2);
  });

  it('breaks a two-message parent cycle into a single root with no self-ancestor', () => {
    const result = convertConversation(
      conversation({
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'user', name: null },
            create_time: 1700000001,
            content: { content_type: 'text', parts: ['one'] },
          },
          parent: 'b',
          children: [],
        },
        b: {
          id: 'b',
          message: {
            id: 'b',
            author: { role: 'user', name: null },
            create_time: 1700000002,
            content: { content_type: 'text', parts: ['two'] },
          },
          parent: 'a',
          children: [],
        },
      }),
      OPTIONS,
    );

    const byId = new Map(result.messages.map((message) => [message.messageId, message]));
    const roots = result.messages.filter(
      (message) => message.parentMessageId === Constants.NO_PARENT,
    );
    expect(roots).toHaveLength(1);

    for (const message of result.messages) {
      const seen = new Set<string>([message.messageId]);
      let current = message.parentMessageId;
      while (current !== Constants.NO_PARENT) {
        expect(seen.has(current)).toBe(false);
        seen.add(current);
        current = byId.get(current)?.parentMessageId ?? Constants.NO_PARENT;
      }
    }
  });

  it('nudges a child timestamp forward when it precedes its parent', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['p'] },
        p: {
          id: 'p',
          message: {
            id: 'p',
            author: { role: 'user', name: null },
            create_time: 1700000010,
            content: { content_type: 'text', parts: ['parent'] },
          },
          parent: 'root',
          children: ['c'],
        },
        c: {
          id: 'c',
          message: {
            id: 'c',
            author: { role: 'user', name: null },
            create_time: 1700000005,
            content: { content_type: 'text', parts: ['child'] },
          },
          parent: 'p',
          children: [],
        },
      }),
      OPTIONS,
    );

    const parent = result.messages.find((message) => message.text === 'parent');
    const child = result.messages.find((message) => message.text === 'child');
    if (!parent || !child) {
      throw new Error('expected parent and child messages to be present');
    }

    expect(child.createdAt.getTime()).toBeGreaterThan(parent.createdAt.getTime());
  });

  it('falls back to the conversation timestamp for a nonnumeric message timestamp', () => {
    const result = convertConversation(
      conversation({
        root: { id: 'root', message: null, parent: null, children: ['a'] },
        a: {
          id: 'a',
          message: {
            id: 'a',
            author: { role: 'user', name: null },
            create_time: 'not-a-timestamp' as unknown as number,
            content: { content_type: 'text', parts: ['hello'] },
          },
          parent: 'root',
          children: [],
        },
      }),
      OPTIONS,
    );

    expect(Number.isFinite(result.createdAt.getTime())).toBe(true);
    expect(result.createdAt.getTime()).toBe(result.messages[0].createdAt.getTime());
  });
});
