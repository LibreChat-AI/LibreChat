/**
 * 답변 끝 "검색 문서 리스트" 표의 『파일명』 → iManage 링크 치환 (2026-09-29).
 *
 * 스트리밍 답변에는 서버가 링크를 못 박으므로 클라이언트가 맵을 받아 바꾼다.
 * 표기 차이(OCR 파생 .md, NFD 한글, 공백)가 있어도 매칭되고, 이미 링크인
 * 자리는 이중 치환하지 않는지 검증한다.
 */
import {
  applyBklAnswerHyperlinks,
  hyperlinkMapFromSources,
  normalizeFileKey,
  parseHyperlinksResponse,
  resolverFromMaps,
  sourceIndexFromSources,
} from '../useBklAnswerHyperlinks';

const URL_A = 'https://km.bkl.co.kr/work/link/d/BKL!12345.1';
const URL_B = 'https://km.bkl.co.kr/work/link/d/BKL!67890.1';

describe('normalizeFileKey', () => {
  it('folds OCR .md suffix, NFD/NFC and surrounding whitespace', () => {
    expect(normalizeFileKey('계약서.pdf.md')).toBe(normalizeFileKey(' 계약서.pdf '));
    expect(normalizeFileKey('계약서.pdf'.normalize('NFD'))).toBe(normalizeFileKey('계약서.pdf'));
    expect(normalizeFileKey('Report.PDF')).toBe(normalizeFileKey('report.pdf'));
  });
});

describe('applyBklAnswerHyperlinks', () => {
  const lookup = new Map([
    [normalizeFileKey('계약서.pdf.md'), URL_A],
    [normalizeFileKey('의견서 (최종).docx'), URL_B],
  ]);

  it('links 『파일명』 cells in the document list table', () => {
    const text = [
      '## 검색 문서 리스트',
      '',
      '| # | 날짜 | 파일명 | 요약 | 인용 |',
      '|:-:|---|---|---|:-:|',
      '| 1 | 2024년 1월 | 『계약서.pdf』 | 핵심 | ○ |',
      '| 2 | 2023년 5월 | 『의견서 (최종).docx』 | 핵심 | ✗ |',
    ].join('\n');
    const out = applyBklAnswerHyperlinks(text, lookup);
    expect(out).toContain(`| [『계약서.pdf』](<${URL_A}>) |`);
    expect(out).toContain(`| [『의견서 (최종).docx』](<${URL_B}>) |`);
  });

  it('leaves unknown files and already-linked mentions untouched', () => {
    const text = `『모르는파일.pdf』 와 [『계약서.pdf』](${URL_A}) 참고`;
    expect(applyBklAnswerHyperlinks(text, lookup)).toBe(text);
  });

  it('is a no-op without a lookup or without any mention', () => {
    expect(applyBklAnswerHyperlinks('본문 『계약서.pdf』', null)).toBe('본문 『계약서.pdf』');
    expect(applyBklAnswerHyperlinks('본문만', lookup)).toBe('본문만');
  });
});

describe('표시명 정제 (FILENAME_DISPLAY_FIX_SPEC)', () => {
  const RAW = 'RE_ SPC 담보_4733289.msg.md';

  it('rewrites 『원본명』 to the server display name while resolving the URL by the raw name', () => {
    const maps = parseHyperlinksResponse({
      mapping: {
        [`『${RAW}』`]: `[『${RAW}』](${URL_A})`,
        __display_names__: { [RAW]: 'RE_ SPC 담보.msg' },
      },
    });
    const resolver = resolverFromMaps(maps!.byName, maps!.byDocId, null, maps!.displayNames);
    expect(applyBklAnswerHyperlinks(`근거: 『${RAW}』`, resolver)).toBe(
      `근거: [『RE_ SPC 담보.msg』](<${URL_A}>)`,
    );
  });

  it('fixes the link text of an already-linked mention without touching its URL', () => {
    const maps = parseHyperlinksResponse({
      mapping: { __display_names__: { [RAW]: 'RE_ SPC 담보.msg' } },
    });
    const resolver = resolverFromMaps(null, null, null, maps!.displayNames);
    expect(applyBklAnswerHyperlinks(`[『${RAW}』](${URL_B})`, resolver)).toBe(
      `[『RE_ SPC 담보.msg』](${URL_B})`,
    );
  });

  it('derives display names from source metadata when the server map lacks them', () => {
    const idx = sourceIndexFromSources([
      {
        document: ['a'],
        metadata: [{ name: `『${RAW}』- [1]`, doc_id: 'd1', imanage_document_number: '4733289' }],
      },
    ]);
    const resolver = resolverFromMaps(null, null, idx);
    expect(applyBklAnswerHyperlinks(`『${RAW}』`, resolver)).toBe('『RE_ SPC 담보.msg』');
  });

  it('strips only the OCR .md when nothing else is known', () => {
    const resolver = resolverFromMaps(new Map([[normalizeFileKey('기타.pdf'), URL_B]]));
    expect(applyBklAnswerHyperlinks('『메모_12.docx.md』', resolver)).toBe('『메모_12.docx』');
  });
});

describe('hyperlinkMapFromSources', () => {
  it('builds file → iManage URL from the citation cache, preferring the first hit', () => {
    const map = hyperlinkMapFromSources([
      {
        document: ['a'],
        metadata: [{ name: '『계약서.pdf.md』- [1]', imanage_preview_url: URL_A }],
      },
      {
        document: ['b'],
        source: { imanage_url: URL_B },
        metadata: [{ name: '『계약서.pdf.md』- [2]' }],
      },
      { document: ['c'], metadata: [{ name: '『링크없음.pdf』- [3]' }] },
    ]);
    expect(map?.get(normalizeFileKey('계약서.pdf'))).toBe(URL_A);
    expect(map?.has(normalizeFileKey('링크없음.pdf'))).toBe(false);
  });

  it('returns null when the cache is empty', () => {
    expect(hyperlinkMapFromSources(undefined)).toBeNull();
    expect(hyperlinkMapFromSources([])).toBeNull();
  });
});

/**
 * 동명 파일 충돌 (2026-10-14): 『주식매매계약서.docx』가 두 사건에 하나씩 있으면
 * 파일명 키만으로는 어느 문서인지 알 수 없다. 인용번호 → 출처 doc_id 로 정확히
 * 고르고, 인용번호가 없으면 이 답변 출처의 doc_id, 그것도 없으면 파일명 지도.
 */
describe('doc_id resolution', () => {
  const URL_C = 'https://km.bkl.co.kr/work/link/d/M!11111.1';
  const sources = [
    { document: ['a'], metadata: [{ name: '『주식매매계약서.docx.md』- [1]', doc_id: 'img_a' }] },
    { document: ['b'], metadata: [{ name: '『주식매매계약서.docx.md』- [2]', doc_id: 'img_b' }] },
    { document: ['c'], metadata: [{ name: '『의견서.pdf.md』- [3]', doc_id: 'img_c' }] },
  ];

  it('parses the __by_doc_id__ side map and ignores it as a file name', () => {
    const maps = parseHyperlinksResponse({
      mapping: {
        '『주식매매계약서.docx.md』': `[『주식매매계약서.docx.md』](${URL_A})`,
        __by_doc_id__: { img_a: URL_A, img_b: URL_B, bad: 'not a url' },
      },
    });
    expect(maps?.byName.get(normalizeFileKey('주식매매계약서.docx'))).toBe(URL_A);
    expect(maps?.byDocId.get('img_b')).toBe(URL_B);
    expect(maps?.byDocId.has('bad')).toBe(false);
    expect(maps?.byName.has(normalizeFileKey('__by_doc_id__'))).toBe(false);
  });

  it('uses the trailing citation number to pick the right document among same-named files', () => {
    const resolver = resolverFromMaps(
      new Map([[normalizeFileKey('주식매매계약서.docx'), URL_A]]),
      new Map([
        ['img_a', URL_A],
        ['img_b', URL_B],
      ]),
      sourceIndexFromSources(sources),
    );
    const text =
      '본문 『주식매매계약서.docx』 - [2] 와 『주식매매계약서.docx』 [1] 그리고 『주식매매계약서.docx』.';
    const out = applyBklAnswerHyperlinks(text, resolver);
    expect(out).toBe(
      `본문 [『주식매매계약서.docx』](<${URL_B}>) - [2] 와 [『주식매매계약서.docx』](<${URL_A}>) [1] 그리고 [『주식매매계약서.docx』](<${URL_A}>).`,
    );
  });

  it('falls back to this answer’s source doc_id, then to the file-name map', () => {
    const resolver = resolverFromMaps(
      new Map([[normalizeFileKey('의견서.pdf'), URL_A]]),
      new Map([['img_c', URL_C]]),
      sourceIndexFromSources(sources),
    );
    // 출처에 있는 의견서 → doc_id 경로(URL_C)가 파일명 지도(URL_A)보다 우선
    expect(applyBklAnswerHyperlinks('『의견서.pdf』', resolver)).toBe(
      `[『의견서.pdf』](<${URL_C}>)`,
    );
    // 출처에 없는 파일 → 파일명 지도
    const r2 = resolverFromMaps(new Map([[normalizeFileKey('기타.pdf'), URL_B]]), null, null);
    expect(applyBklAnswerHyperlinks('『기타.pdf』', r2)).toBe(`[『기타.pdf』](<${URL_B}>)`);
  });

  it('indexes citation numbers by source order and takes URLs from the source payload', () => {
    const idx = sourceIndexFromSources([
      {
        document: ['a'],
        source: { imanage_url: URL_A },
        metadata: [{ name: '『x.pdf』- [1]', doc_id: 'd1' }],
      },
      { document: ['a2'], metadata: [{ name: '『x.pdf』- [2]', doc_id: 'd1' }] },
      { document: ['b'], metadata: [{ name: '『y.pdf』- [3]' }] }, // doc_id 없음 → 건너뜀
    ]);
    expect(idx?.citationDocIds.get(1)).toBe('d1');
    expect(idx?.citationDocIds.get(2)).toBe('d1');
    expect(idx?.citationDocIds.has(3)).toBe(false);
    expect(idx?.byDocId.get('d1')).toBe(URL_A);
    expect(idx?.nameDocIds.get(normalizeFileKey('x.pdf'))).toEqual(['d1']);
  });
});
