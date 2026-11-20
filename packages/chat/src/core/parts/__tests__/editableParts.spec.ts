import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { hasEditablePart, isEditablePart } from '../editableParts';

const artifactText = ':::artifact{identifier="demo" type="text/html" title="Demo"}\n<div />\n:::';

describe('hasEditablePart', () => {
  it.each([
    ['a message with no content array', undefined],
    ['a text part', [{ type: ContentTypes.TEXT, text: 'an answer' }]],
    ['a reasoning part', [{ type: ContentTypes.THINK, think: 'thinking out loud' }]],
    [
      'a text part beside a tool call',
      [
        { type: ContentTypes.TOOL_CALL, tool_call: {} },
        { type: ContentTypes.TEXT, text: 'an answer' },
      ],
    ],
    [
      'prose beside an artifact',
      [
        { type: ContentTypes.TEXT, text: artifactText },
        { type: ContentTypes.TEXT, text: 'and here is what it does' },
      ],
    ],
  ])('is true for %s', (_label, content) => {
    expect(hasEditablePart({ content } as TMessage)).toBe(true);
  });

  /** Every turn whose editor would open with no field: a compaction that finished,
   *  one that persisted an error part instead, tool output, and an answer that is
   *  only an artifact — `EditContentParts` keeps that one in its read-only
   *  renderer. */
  it.each([
    ['an empty content array', []],
    [
      'a summary-only turn',
      [
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'compacted' }],
        },
      ],
    ],
    ['an error-only turn', [{ type: ContentTypes.ERROR, error: 'failed' }]],
    [
      'text that belongs to a tool call',
      [{ type: ContentTypes.TEXT, text: 'tool output', tool_call_ids: ['call-1'] }],
    ],
    ['an artifact-only answer', [{ type: ContentTypes.TEXT, text: artifactText }]],
  ])('is false for %s', (_label, content) => {
    expect(hasEditablePart({ content } as TMessage)).toBe(false);
  });
});

describe('encrypted reasoning in the editor', () => {
  /** Bedrock `redactedContent`, base64-encoded into THINK text by the SDK. */
  const encoded = Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 37 + 3) % 256)).toString(
    'base64',
  );

  it('offers no field for reasoning that is only an encrypted payload', () => {
    expect(
      isEditablePart({ type: ContentTypes.THINK, think: encoded } as TMessageContentParts),
    ).toBe(false);
    expect(
      hasEditablePart({
        content: [{ type: ContentTypes.THINK, think: `<think>${encoded}</think>` }],
      } as TMessage),
    ).toBe(false);
  });

  it('keeps mixed reasoning read-only so an edit cannot drop its payload', () => {
    const part = {
      type: ContentTypes.THINK,
      think: `Checking the manifest. ${encoded}`,
    } as TMessageContentParts;
    expect(isEditablePart(part)).toBe(false);
  });

  it('still edits readable reasoning and any text part', () => {
    expect(
      isEditablePart({
        type: ContentTypes.THINK,
        think: 'Checking the manifest.',
      } as TMessageContentParts),
    ).toBe(true);
    expect(
      isEditablePart({
        type: ContentTypes.TEXT,
        text: `Token: ${encoded}`,
      } as TMessageContentParts),
    ).toBe(true);
  });
});
