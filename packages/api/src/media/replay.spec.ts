import type { MessageContentComplex } from '@librechat/agents';
import { collapseAssistantReplayContent, prepareAssistantToolReplayContent } from './replay';

describe('collapseAssistantReplayContent', () => {
  const image = (extra: Partial<MessageContentComplex> = {}): MessageContentComplex =>
    ({
      type: 'image_url',
      image_url: { url: 'https://example.test/chart.png' },
      ...extra,
    }) as MessageContentComplex;

  it('joins text parts with newlines and drops non-native parts', () => {
    expect(
      collapseAssistantReplayContent([
        { type: 'text', text: '  First' },
        image(),
        { type: 'text', text: 'Second  ' },
      ]),
    ).toBe('First\nSecond');
  });

  it('folds to an empty string when no text remains', () => {
    expect(collapseAssistantReplayContent([image()])).toBe('');
  });

  it('returns the same array, in order, when any part carries native media', () => {
    const variations: MessageContentComplex[][] = [
      [
        { type: 'text', text: 'Drawing.' },
        image({ native_media: { continuationRef: 'native:job-1:0' } }),
        { type: 'text', text: 'Done.' },
      ],
      [
        { type: 'text', text: 'before', native_media: { continuationRef: 'opaque' } },
        { type: 'image_file', image_file: { file_id: 'immutable' } },
        { type: 'text', text: 'after' },
      ],
    ];
    for (const parts of variations) expect(collapseAssistantReplayContent(parts)).toBe(parts);
  });

  it('preserves the existing double newline before a tool anchor and its standalone whitespace', () => {
    expect(
      prepareAssistantToolReplayContent([{ type: 'text', text: 'First' }], {
        type: 'text',
        text: 'Tool anchor',
      }),
    ).toBe('First\n\nTool anchor');
    expect(prepareAssistantToolReplayContent([], { type: 'text', text: '  Tool anchor\n\n' })).toBe(
      '  Tool anchor\n\n',
    );
    expect(
      prepareAssistantToolReplayContent([image()], { type: 'text', text: '  Tool anchor\n' }),
    ).toBe('Tool anchor');
  });

  it('keeps native images and signed text ordered through a tool-anchor flush', () => {
    const first = image({ native_media: { continuationRef: 'message:0' } });
    const anchor: MessageContentComplex = { type: 'text', text: '  Tool anchor\n' };
    expect(prepareAssistantToolReplayContent([first], anchor)).toEqual([first, anchor]);
  });
});
