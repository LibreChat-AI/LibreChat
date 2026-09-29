import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { hasEditablePart } from '../editableParts';

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
