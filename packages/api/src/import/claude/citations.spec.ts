import type { ClaudeCitation } from '~/import/types';
import { addSource, applyCitations, createSourceIndex, buildSearchAttachment } from './citations';

const SPAN_OPEN = '\ue203';
const SPAN_CLOSE = '\ue204';
const ANCHOR = '\ue202';
const GROUP_OPEN = '\ue200';
const GROUP_CLOSE = '\ue201';

function citation(start: number, end: number, url: string): ClaudeCitation {
  return {
    uuid: `c-${start}-${end}`,
    start_index: start,
    end_index: end,
    details: { type: 'web_search_citation', url },
  };
}

describe('applyCitations', () => {
  it('wraps a mid-sentence range and anchors it to the registered source', () => {
    const index = createSourceIndex();
    const text = 'Redis needs a URI when enabled. Set it in your env file.';

    const cited = applyCitations(text, [citation(0, 36, 'https://a.example/redis')], index);

    expect(cited).toBe(
      `${SPAN_OPEN}Redis needs a URI when enabled. Set ${SPAN_CLOSE}${ANCHOR}turn0search0it in your env file.`,
    );
    expect(index.sources).toEqual([{ link: 'https://a.example/redis' }]);
  });

  it('keeps later offsets valid when an earlier range is also marked', () => {
    const index = createSourceIndex();
    const text = 'First claim. Second claim.';

    const cited = applyCitations(
      text,
      [citation(0, 12, 'https://a.example/one'), citation(13, 26, 'https://b.example/two')],
      index,
    );

    expect(cited).toBe(
      `${SPAN_OPEN}First claim.${SPAN_CLOSE}${ANCHOR}turn0search0 ${SPAN_OPEN}Second claim.${SPAN_CLOSE}${ANCHOR}turn0search1`,
    );
  });

  it('renders two sources sharing one range as a composite anchor group', () => {
    const index = createSourceIndex();
    const text = 'One shared claim.';

    const cited = applyCitations(
      text,
      [citation(0, 17, 'https://a.example/one'), citation(0, 17, 'https://b.example/two')],
      index,
    );

    expect(cited).toBe(
      `${SPAN_OPEN}One shared claim.${SPAN_CLOSE}${GROUP_OPEN}${ANCHOR}turn0search0${ANCHOR}turn0search1${GROUP_CLOSE}`,
    );
    expect(index.sources).toHaveLength(2);
  });

  it('reuses one anchor index for a URL cited twice', () => {
    const index = createSourceIndex();
    const text = 'Claim one. Claim two.';

    const cited = applyCitations(
      text,
      [citation(0, 10, 'https://a.example/same'), citation(11, 21, 'https://a.example/same')],
      index,
    );

    expect(index.sources).toHaveLength(1);
    expect(cited).toContain(`${ANCHOR}turn0search0 `);
    expect(cited.endsWith(`${ANCHOR}turn0search0`)).toBe(true);
  });

  it('registers the source but inserts no marker inside a fenced code block', () => {
    const index = createSourceIndex();
    const text = 'Run:\n```bash\nREDIS_URI=redis://host\n```\nDone.';

    const cited = applyCitations(text, [citation(13, 34, 'https://a.example/redis')], index);

    expect(cited).toBe(text);
    expect(index.sources).toEqual([{ link: 'https://a.example/redis' }]);
  });

  it('registers the source but inserts no marker inside an inline code span', () => {
    const index = createSourceIndex();
    const text = 'Set `REDIS_URI=redis://host` first.';

    const cited = applyCitations(text, [citation(6, 15, 'https://a.example/redis')], index);

    expect(cited).toBe(text);
    expect(index.sources).toHaveLength(1);
  });

  it('drops an out-of-bounds or empty range without corrupting the text', () => {
    const index = createSourceIndex();
    const text = 'Short.';

    expect(applyCitations(text, [citation(0, 999, 'https://a.example/x')], index)).toBe(text);
    expect(applyCitations(text, [citation(3, 3, 'https://a.example/y')], index)).toBe(text);
    expect(applyCitations(text, [citation(-1, 4, 'https://a.example/z')], index)).toBe(text);
    expect(index.sources).toHaveLength(3);
  });

  it('drops a range nested inside an already-marked range', () => {
    const index = createSourceIndex();
    const text = 'Outer claim text.';

    const cited = applyCitations(
      text,
      [citation(0, 17, 'https://a.example/outer'), citation(6, 11, 'https://b.example/inner')],
      index,
    );

    expect(cited).toBe(`${SPAN_OPEN}Outer claim text.${SPAN_CLOSE}${ANCHOR}turn0search0`);
    expect(index.sources).toHaveLength(2);
  });

  it('ignores a citation carrying no url', () => {
    const index = createSourceIndex();
    const text = 'No source here.';

    const cited = applyCitations(
      text,
      [{ uuid: 'c', start_index: 0, end_index: 15, details: { type: 'web_search_citation' } }],
      index,
    );

    expect(cited).toBe(text);
    expect(index.sources).toHaveLength(0);
  });

  it('leaves text untouched when there are no citations', () => {
    const index = createSourceIndex();
    expect(applyCitations('plain', undefined, index)).toBe('plain');
    expect(applyCitations('plain', [], index)).toBe('plain');
    expect(buildSearchAttachment(index)).toBeUndefined();
  });
});

describe('addSource', () => {
  it('upgrades a link-only entry with a title and snippet seen later', () => {
    const index = createSourceIndex();

    const first = addSource(index, { link: 'https://a.example/x' });
    const second = addSource(index, {
      link: 'https://a.example/x',
      title: 'Guide',
      snippet: 'Summary',
    });

    expect(second).toBe(first);
    expect(index.sources).toEqual([
      { link: 'https://a.example/x', title: 'Guide', snippet: 'Summary' },
    ]);
  });

  it('builds a turn-0 web_search attachment from the registered sources', () => {
    const index = createSourceIndex();
    addSource(index, { link: 'https://a.example/x', title: 'X' });

    expect(buildSearchAttachment(index)).toEqual({
      type: 'web_search',
      web_search: { turn: 0, organic: [{ link: 'https://a.example/x', title: 'X' }] },
    });
  });
});
