import { Constants, ContentTypes } from 'librechat-data-provider';
import {
  sanitizeUIResourceContent,
  stripMessageUIResourceMarkers,
  stripUIResourceMarkers,
} from './stripUIResourceMarkers';

describe('stripUIResourceMarkers', () => {
  it('removes markers from renderable text while preserving non-text Markdown nodes', () => {
    const markdown = [
      'Before \\ui{rendered} after',
      '`\\ui{inline}`',
      '```text',
      '\\ui{fenced}',
      '```',
      '<div>\\ui{html}</div>',
      '$$\\ui{inline-math}$$',
      '$$',
      '\\ui{display-math}',
      '$$',
    ].join('\n');

    expect(stripUIResourceMarkers(markdown)).toBe(markdown.replace('\\ui{rendered}', ''));
  });

  it('preserves markers inside inline and display math nodes', () => {
    const markdown = ['$$\\ui{inline-math}$$', '', '$$', '\\ui{display-math}', '$$'].join('\n');
    expect(stripUIResourceMarkers(markdown)).toBe(markdown);
    expect(stripUIResourceMarkers('$\\ui{rendered}$')).toBe('$$');
  });

  it('preserves directive attributes that the renderer does not visit as text', () => {
    const markdown = '::artifact{title="\\ui{example}"}';
    expect(stripUIResourceMarkers(markdown)).toBe(markdown);
  });

  it('preserves text directive labels replaced before MCP marker rendering', () => {
    const markdown = ':note[\\ui{directive}] outside \\ui{outside}';
    expect(stripUIResourceMarkers(markdown)).toBe(':note[\\ui{directive}] outside ');
  });

  it('removes markers after Markdown escapes and character references are decoded', () => {
    const markdown = [
      'Encoded &#92;ui{backslash}',
      'Encoded \\ui&#123;braces&#125;',
      'Escaped \\ui\\{braces\\}',
    ].join('\n');

    expect(stripUIResourceMarkers(markdown)).toBe(['Encoded ', 'Encoded ', 'Escaped '].join('\n'));
  });

  it('removes markers formed by citation cleanup before MCP marker rendering', () => {
    const markdown = [
      'Actual \\u\ue206i{actual}',
      'Literal \\u\\ue206i{literal}',
      'Entity \\u&#xE206;i{entity}',
      'Mixed \\u&#92;ue206i{mixed}',
    ].join('\n');
    expect(stripUIResourceMarkers(markdown)).toBe(
      ['Actual ', 'Literal ', 'Entity ', 'Mixed '].join('\n'),
    );
  });

  it('preserves markers inside composite citations consumed before MCP marker rendering', () => {
    const markdown = '\\ue200\\ue202turn0search0 \\ui{citation}\\ue201 outside \\ui{outside}';
    expect(stripUIResourceMarkers(markdown)).toBe(
      '\\ue200\\ue202turn0search0 \\ui{citation}\\ue201 outside ',
    );
    expect(stripUIResourceMarkers('\\ue200 invalid \\ui{rendered}\\ue201')).toBe(
      '\\ue200 invalid \\ue201',
    );
    expect(stripUIResourceMarkers('\\ue200\n\\ue202turn0search0 \\ui{rendered}\\ue201')).toBe(
      '\\ue200\n\\ue202turn0search0 \\ue201',
    );
  });

  it('preserves highlighted citation text-node boundaries before MCP marker rendering', () => {
    const acrossBoundary = '\\u\\ue203i{id}\\ue204';
    expect(stripUIResourceMarkers(acrossBoundary)).toBe(acrossBoundary);
    expect(stripUIResourceMarkers('\\ue203\\ui{inside}\\ue204')).toBe('\\ue203\\ue204');
    expect(
      stripUIResourceMarkers('\\ue203 text \\ue200\\ue202turn0search0 \\ui{nested}\\ue201\\ue204'),
    ).toBe('\\ue203 text \\ue200\\ue202turn0search0 \\ue201\\ue204');
  });

  it('uses the earliest citation match when highlight and composite ranges cross', () => {
    const markdown = '\\ue203 text \\ue200\\ue202turn0search0 \\ui{id}\\ue204 tail \\ue201';
    expect(stripUIResourceMarkers(markdown)).toBe(
      '\\ue203 text \\ue200\\ue202turn0search0 \\ue204 tail \\ue201',
    );
  });

  it('preserves text boundaries around invalid composite citations', () => {
    const markdown = '\\u\\ue200\\ue201i{id}';
    expect(stripUIResourceMarkers(markdown)).toBe(markdown);
  });

  it('handles many unmatched citation openers in linear time', () => {
    const markdown = `${'\\ue203'.repeat(16_000)}\\ui{rendered}`;
    expect(stripUIResourceMarkers(markdown)).toBe('\\ue203'.repeat(16_000));
  });

  it('preserves markers in message text that bypasses Markdown rendering', () => {
    expect(stripMessageUIResourceMarkers('Error \\ui{literal}', true)).toBe('Error \\ui{literal}');
    expect(
      stripMessageUIResourceMarkers(':::thinking Hidden \\ui{hidden} ::: Visible \\ui{visible}'),
    ).toBe(':::thinking Hidden \\ui{hidden} ::: Visible ');
    expect(stripMessageUIResourceMarkers('\\u:::thinking Hidden :::i{formed}')).toBe(
      ':::thinking Hidden :::',
    );
    expect(stripMessageUIResourceMarkers(':::thinking hidden :::    \\ui{id}')).toBe(
      ':::thinking hidden :::    ',
    );
  });

  it('handles paragraph continuations and container code according to CommonMark', () => {
    const markdown = [
      'intro',
      '    \\ui{paragraph}',
      '',
      '    \\ui{indented-code}',
      '> ```',
      '> \\ui{quote-code}',
      'outside \\ui{outside}',
    ].join('\n');

    expect(stripUIResourceMarkers(markdown)).toBe(
      markdown.replace('\\ui{paragraph}', '').replace('\\ui{outside}', ''),
    );
  });

  it('maps markers across CRLF paragraph continuations', () => {
    const markdown = 'intro\r\n    \\ui{paragraph}\r\nnext \\ui{next}';
    expect(stripUIResourceMarkers(markdown)).toBe('intro\r\n    \r\nnext ');
  });

  it('maps markers across blockquote paragraph prefixes', () => {
    const markdown = '> intro\n> \\ui{paragraph}\n>\n>     \\ui{code}';
    expect(stripUIResourceMarkers(markdown)).toBe(markdown.replace('\\ui{paragraph}', ''));
  });

  it('handles escaped blockquote content and CommonMark replacement characters', () => {
    expect(stripUIResourceMarkers('> intro\n> \\> \\ui{paragraph}')).toBe('> intro\n> \\> ');
    expect(stripUIResourceMarkers('prefix\0 \\ui{paragraph}')).toBe('prefix\0 ');
  });

  it('handles long literal text without per-character source-span objects', () => {
    const markdown = `\\not-a-marker ${'a'.repeat(100_000)} & plain text`;
    expect(stripUIResourceMarkers(markdown)).toBe(markdown);
  });

  it('maps many encoded markers with a monotonic source-segment cursor', () => {
    const markdown = Array.from({ length: 1_000 }, (_, index) => `&#92;ui{id${index}}`).join(' ');
    expect(stripUIResourceMarkers(markdown)).toBe(' '.repeat(999));
  });

  it('walks deeply nested Markdown without recursive traversal', () => {
    const prefix = '> '.repeat(500);
    expect(stripUIResourceMarkers(`${prefix}\\ui{deep}`)).toBe(prefix);
  });

  it('recursively sanitizes TextData and subagent content while preserving annotations', () => {
    const content = [
      {
        type: 'tool_call',
        tool_call: {
          subagent_content: [
            {
              type: ContentTypes.TEXT,
              text: {
                value: 'Before \\ui{nested} after',
                annotations: [{ type: 'citation' }],
              },
            },
          ],
        },
      },
    ];

    expect(sanitizeUIResourceContent(content)).toEqual([
      {
        type: 'tool_call',
        tool_call: {
          subagent_content: [
            {
              type: ContentTypes.TEXT,
              text: { value: 'Before  after', annotations: [{ type: 'citation' }] },
            },
          ],
        },
      },
    ]);
  });

  it('sanitizes deeply nested subagent content without recursive traversal', () => {
    const depth = 10_000;
    let nestedContent: unknown[] = [{ type: ContentTypes.TEXT, text: 'Deep \\ui{deep} content' }];
    for (let i = 0; i < depth; i++) {
      nestedContent = [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { subagent_content: nestedContent },
        },
      ];
    }

    let cursor = sanitizeUIResourceContent(nestedContent) as unknown[];
    for (let i = 0; i < depth; i++) {
      const part = cursor[0] as { tool_call: { subagent_content: unknown[] } };
      cursor = part.tool_call.subagent_content;
    }
    expect(cursor).toEqual([{ type: ContentTypes.TEXT, text: 'Deep  content' }]);
  });

  it('preserves top-level user text while sanitizing assistant-rendered subagent fields', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'User example \\ui{literal}' },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: Constants.SUBAGENT,
          output: 'Legacy \\ui{legacy} output',
          subagent_content: [
            { type: ContentTypes.TEXT, text: 'Nested \\ui{nested} content' },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: {
                name: Constants.SUBAGENT,
                output: 'Deep \\ui{deep} output',
              },
            },
          ],
        },
      },
    ];

    expect(sanitizeUIResourceContent(content, false)).toEqual([
      { type: ContentTypes.TEXT, text: 'User example \\ui{literal}' },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: Constants.SUBAGENT,
          output: 'Legacy  output',
          subagent_content: [
            { type: ContentTypes.TEXT, text: 'Nested  content' },
            {
              type: ContentTypes.TOOL_CALL,
              tool_call: { name: Constants.SUBAGENT, output: 'Deep  output' },
            },
          ],
        },
      },
    ]);
  });
});
