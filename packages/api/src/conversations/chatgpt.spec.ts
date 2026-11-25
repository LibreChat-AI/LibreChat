import { Constants, ContentTypes } from 'librechat-data-provider';

import type {
  ChatGptMapping,
  ChatGptCitation,
  ChatGptMappingNode,
  ChatGptExportContent,
} from './chatgpt';
import { createChatGptLineage, linkChatGptCitations } from './chatgpt';

const node = (
  parent: string | null,
  role: string,
  contentType: string,
  extra: ChatGptExportContent = {},
): ChatGptMappingNode => ({
  parent,
  message: { author: { role }, content: { content_type: contentType, ...extra } },
});

/** Export ids map to imported ids with an `imported-` prefix. */
const importedIds = (mapping: ChatGptMapping): Map<string, string> =>
  new Map(
    Object.entries(mapping)
      .filter(([, entry]) => entry?.message?.content?.content_type)
      .map(([id]) => [id, `imported-${id}`]),
  );

const webpage = (start_ix: number, end_ix: number, title: string): ChatGptCitation => ({
  start_ix,
  end_ix,
  metadata: { type: 'webpage', title, url: `https://example.com/${title}` },
});

describe('createChatGptLineage', () => {
  describe('findValidParent', () => {
    it('passes over system, reasoning-recap and thoughts ancestors', () => {
      const mapping: ChatGptMapping = {
        user: node(null, 'user', 'text'),
        system: node('user', 'system', 'text'),
        thoughts: node('system', 'assistant', 'thoughts'),
        recap: node('thoughts', 'assistant', 'reasoning_recap'),
      };
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      expect(lineage.findValidParent('recap')).toBe('imported-user');
      expect(lineage.findValidParent('system')).toBe('imported-user');
      expect(lineage.findValidParent('user')).toBe('imported-user');
    });

    it('roots a message whose ancestry is missing, empty or unmapped', () => {
      const mapping: ChatGptMapping = {
        empty: { parent: null, message: null },
        system: node('empty', 'system', 'text'),
        untyped: { parent: null, message: { author: { role: 'user' }, content: {} } },
      };
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      expect(lineage.findValidParent(undefined)).toBe(Constants.NO_PARENT);
      expect(lineage.findValidParent('absent')).toBe(Constants.NO_PARENT);
      expect(lineage.findValidParent('system')).toBe(Constants.NO_PARENT);
      expect(lineage.findValidParent('untyped')).toBe(Constants.NO_PARENT);
    });

    it('roots a message whose passed-over ancestors form a cycle, from any entry point', () => {
      const mapping: ChatGptMapping = {
        a: node('b', 'system', 'text'),
        b: node('a', 'system', 'text'),
      };
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      expect(lineage.findValidParent('a')).toBe(Constants.NO_PARENT);
      expect(lineage.findValidParent('b')).toBe(Constants.NO_PARENT);
    });

    it('resolves many descendants of one long run of system messages', () => {
      const depth = 20_000;
      const mapping: Record<string, ChatGptMappingNode> = { root: node(null, 'user', 'text') };
      for (let i = 0; i < depth; i++) {
        mapping[`s${i}`] = node(i === 0 ? 'root' : `s${i - 1}`, 'system', 'text');
      }
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      const parents = new Set<string>();
      const startedAt = performance.now();
      for (let i = 0; i < depth; i++) {
        parents.add(lineage.findValidParent(`s${depth - 1}`));
      }
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(1000);
      expect([...parents]).toEqual(['imported-root']);
    });
  });

  describe('findThinkingContent', () => {
    it('reads thoughts through reasoning recaps', () => {
      const mapping: ChatGptMapping = {
        thoughts: node(null, 'assistant', 'thoughts', {
          thoughts: [{ content: 'first' }, { summary: 'second' }, { content: '' }],
        }),
        recap: node('thoughts', 'assistant', 'reasoning_recap'),
      };
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      expect(lineage.findThinkingContent('recap')).toEqual([
        { type: ContentTypes.THINK, think: 'first\n\nsecond' },
      ]);
    });

    it('returns a separate part for each response sharing the same thoughts', () => {
      const mapping: ChatGptMapping = {
        thoughts: node(null, 'assistant', 'thoughts', { thoughts: [{ content: 'shared' }] }),
      };
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      const first = lineage.findThinkingContent('thoughts');
      const second = lineage.findThinkingContent('thoughts');
      expect(second).toEqual(first);
      expect(second[0]).not.toBe(first[0]);
    });

    it('returns nothing for other ancestors, malformed thoughts and recap cycles', () => {
      const mapping: ChatGptMapping = {
        text: node(null, 'user', 'text'),
        malformed: node(null, 'assistant', 'thoughts', { thoughts: null }),
        a: node('b', 'assistant', 'reasoning_recap'),
        b: node('a', 'assistant', 'reasoning_recap'),
      };
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      expect(lineage.findThinkingContent('text')).toEqual([]);
      expect(lineage.findThinkingContent('malformed')).toEqual([]);
      expect(lineage.findThinkingContent('a')).toEqual([]);
      expect(lineage.findThinkingContent(null)).toEqual([]);
    });

    it('follows a recap run deeper than the call stack', () => {
      const depth = 100_000;
      const mapping: Record<string, ChatGptMappingNode> = {
        thoughts: node(null, 'assistant', 'thoughts', { thoughts: [{ content: 'deep' }] }),
      };
      for (let i = 0; i < depth; i++) {
        mapping[`r${i}`] = node(i === 0 ? 'thoughts' : `r${i - 1}`, 'assistant', 'reasoning_recap');
      }
      const lineage = createChatGptLineage(mapping, importedIds(mapping));

      expect(lineage.findThinkingContent(`r${depth - 1}`)).toEqual([
        { type: ContentTypes.THINK, think: 'deep' },
      ]);
      const startedAt = performance.now();
      for (let i = 0; i < 1000; i++) {
        lineage.findThinkingContent(`r${depth - 1}`);
      }
      expect(performance.now() - startedAt).toBeLessThan(1000);
    });
  });
});

describe('linkChatGptCitations', () => {
  const text = 'Intro 【1†a】 middle 【2†b】 end';
  const first = text.indexOf('【1');
  const second = text.indexOf('【2');

  it('replaces adjacent and separated markers in any listed order', () => {
    const citations = [webpage(second, second + 5, 'b'), webpage(first, first + 5, 'a')];

    expect(linkChatGptCitations(text, citations)).toBe(
      'Intro  ([a](https://example.com/a)) middle  ([b](https://example.com/b)) end',
    );
  });

  it('clamps an end index past the text as slice would', () => {
    const tail = 'Tail 【9†z】';
    expect(linkChatGptCitations(tail, [webpage(5, tail.length + 1, 'z')])).toBe(
      'Tail  ([z](https://example.com/z))',
    );
  });

  it('leaves out non-webpage, inverted, fractional, negative and overlapping citations', () => {
    const citations: Array<ChatGptCitation | null> = [
      null,
      { start_ix: first, end_ix: first + 5, metadata: { type: 'file', title: 'f', url: 'u' } },
      webpage(second + 5, second, 'inverted'),
      webpage(first + 0.5, first + 5, 'fractional'),
      webpage(-3, 2, 'negative'),
      webpage(second, second + 5, 'b'),
      webpage(second - 2, second + 1, 'overlap'),
    ];

    expect(linkChatGptCitations(text, citations)).toBe(
      'Intro 【1†a】 middle  ([b](https://example.com/b)) end',
    );
  });

  it('returns the text unchanged when there is nothing to link', () => {
    expect(linkChatGptCitations(text, undefined)).toBe(text);
    expect(linkChatGptCitations(text, [])).toBe(text);
    expect(linkChatGptCitations('', [webpage(0, 1, 'a')])).toBe('');
  });

  it('links tens of thousands of citations in one message', () => {
    const count = 20_000;
    const marker = '【†】';
    const body = `${'word '.repeat(19)}${marker}`.repeat(count);
    const span = body.length / count;
    const citations = Array.from({ length: count }, (_, index) =>
      webpage((index + 1) * span - marker.length, (index + 1) * span, 's'),
    );

    const startedAt = performance.now();
    const linked = linkChatGptCitations(body, citations);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    expect(linked).not.toContain(marker);
    expect(linked.split(' ([s](https://example.com/s))')).toHaveLength(count + 1);
  });
});
