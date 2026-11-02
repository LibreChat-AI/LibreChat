/** FILENAME_DISPLAY_FIX_SPEC — 표시용 파일명 정제 (클라이언트 폴백 규칙). */
import { displayFileName, displayNameFromMeta, displayNameOf } from '../displayName';

describe('displayFileName', () => {
  it.each([
    [
      'RE_ SPC 담보 [BKL-M.FID2086960]_4733289.msg.md',
      4733289,
      'RE_ SPC 담보 [BKL-M.FID2086960].msg',
    ],
    ['0102 이사회규정(20140225)_12964400.docx.md', '12964400', '0102 이사회규정(20140225).docx'],
    ['Simone_SSA.docx.md', null, 'Simone_SSA.docx'],
    ['보고서_777.pdf', 777, '보고서.pdf'],
    // document_number 불일치 → 보존
    ['계약서_250311.pdf.md', 4733289, '계약서_250311.pdf'],
    ['(2021.12.08) 증거제출서.pdf.md', 4733289, '(2021.12.08) 증거제출서.pdf'],
    ['갑 제1호증_12.pdf.md', 4733289, '갑 제1호증_12.pdf'],
    // 중간의 같은 숫자는 보존, 끝의 것만
    ['4733289_계약서_4733289.pdf.md', 4733289, '4733289_계약서.pdf'],
    ['계약서_abc.pdf.md', 'abc', '계약서_abc.pdf'],
    ['', 123, ''],
    [null, 123, ''],
  ])('%s / %s → %s', (name, num, expected) => {
    expect(displayFileName(name as string | null, num as string | number | null)).toBe(expected);
  });

  it('keeps .md when stripMd is off', () => {
    expect(displayFileName('a_12.pdf.md', 12, { stripMd: false })).toBe('a.pdf.md');
  });
});

describe('displayNameFromMeta', () => {
  it('prefers the server display_name', () => {
    expect(
      displayNameFromMeta({ name: '『메일_1.msg.md』- [3]', display_name: '서버가 준 이름.msg' }),
    ).toBe('서버가 준 이름.msg');
  });

  it('falls back to header parsing + document_number rule', () => {
    expect(
      displayNameFromMeta({
        name: '『메일_4733289.msg.md』- [3]',
        imanage_document_number: '4733289',
      }),
    ).toBe('메일.msg');
    expect(displayNameFromMeta({ file_name: '메모.docx.md' })).toBe('메모.docx');
  });

  it('returns the fallback when nothing usable', () => {
    expect(displayNameFromMeta(undefined, '출처 문서')).toBe('출처 문서');
    expect(displayNameFromMeta({}, '출처 문서')).toBe('출처 문서');
  });
});

describe('displayNameOf', () => {
  it('uses display_name, else computes from file_name', () => {
    expect(displayNameOf({ display_name: 'X.pdf', file_name: 'X_9.pdf.md' })).toBe('X.pdf');
    expect(displayNameOf({ file_name: 'X_9.pdf.md', imanage_document_number: 9 })).toBe('X.pdf');
    expect(displayNameOf({ file_name: 'X_9.pdf.md' })).toBe('X_9.pdf');
  });
});
