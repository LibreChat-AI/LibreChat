import { extractMessageContent, snapshotExternalMessages } from './messages';

const messages = (output: unknown) => [
  {
    role: 'assistant',
    content: [{ type: 'tool_call', tool_call: { name: 'inspect', args: '{}', output } }],
  },
];

describe('persisted tool result media protection', () => {
  it.each([false, true])(
    'inspects media with file and tool-output attribution; prepared=%s',
    (prepared) => {
      const input = messages([
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        { type: 'file', file: { filename: 'notes.txt', file_data: 'inline submitted text' } },
        { type: 'file', file: { file_url: 'https://example.com/report.pdf' } },
      ]);
      const fragments = [
        ...extractMessageContent(prepared ? snapshotExternalMessages(input) : input),
      ];
      for (const [text, field, suffix] of [
        ['https://example.com/image.png', 'uri', '/0/image_url/url'],
        ['notes.txt', 'name', '/1/file/filename'],
        ['inline submitted text', 'content', '/1/file/file_data'],
        ['https://example.com/report.pdf', 'uri', '/2/file/file_url'],
      ]) {
        expect(fragments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              text,
              source: 'file',
              field,
              path: `/0/content/0/tool_call/output${suffix}`,
            }),
            expect.objectContaining({ text, source: 'tool_argument', field: 'output' }),
          ]),
        );
      }
    },
  );

  it('does not expose encoded data as inspectable text', () => {
    const fragments = [
      ...extractMessageContent(
        messages([
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          { type: 'file', file: { file_data: 'data:application/pdf;base64,AA==' } },
        ]),
      ),
    ];
    expect(fragments.some(({ text }) => text.includes('base64'))).toBe(false);
  });

  it('fails closed on exhausted shared traversal work', () => {
    expect(() => [
      ...extractMessageContent(
        messages([{ type: 'file', file: { file_data: 'submitted text' } }]),
        { visitedNodes: 0, maxNodes: 4 },
      ),
    ]).toThrow();
  });

  it('fails closed on unreadable nested media', () => {
    const file = Object.defineProperty({}, 'file_data', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    expect(() => [...extractMessageContent(messages([{ type: 'file', file }]))]).toThrow();
  });
});
