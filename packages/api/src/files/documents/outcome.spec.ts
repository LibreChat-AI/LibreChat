import {
  isDocumentParserRefusal,
  isPartialDocumentText,
  resolveDocumentExtraction,
} from './outcome';

const text = (value: string, extra: Record<string, unknown> = {}) => ({ text: value, ...extra });

const attempt = (overrides: Partial<Parameters<typeof resolveDocumentExtraction>[0]> = {}) => ({
  delimitedText: false,
  parse: jest.fn().mockResolvedValue(text('parsed')),
  assertPartialTextAllowed: jest.fn(),
  ...overrides,
});

describe('resolveDocumentExtraction', () => {
  it('takes the parser result when it read the whole document', async () => {
    const runConfiguredOCR = jest.fn();
    const input = attempt({ runConfiguredOCR });

    await expect(resolveDocumentExtraction(input)).resolves.toEqual(text('parsed'));
    /* The expensive service is not asked for what the parser already had. */
    expect(runConfiguredOCR).not.toHaveBeenCalled();
    expect(input.assertPartialTextAllowed).not.toHaveBeenCalled();
  });

  /* A part-scanned document: the parser reads the pages that have text, and only the
   * pages it could not read are what OCR is for. */
  it.each([
    ['named pages', { pagesNeedingOcr: [2] }],
    ['embedded artwork', { mayOmitContent: true }],
  ])('completes a partial extraction (%s) with the configured service', async (_label, holes) => {
    const runConfiguredOCR = jest.fn().mockResolvedValue(text('ocr text'));
    const input = attempt({
      parse: jest.fn().mockResolvedValue(text('partial', holes)),
      runConfiguredOCR,
    });

    await expect(resolveDocumentExtraction(input)).resolves.toEqual(text('ocr text'));
    expect(runConfiguredOCR).toHaveBeenCalledWith({ throwOnMissingCapability: false });
  });

  /* Nothing was read, so the missing capability is the answer the user needs rather than
   * a silent empty result. */
  it('demands the OCR capability when the parser produced no text at all', async () => {
    const runConfiguredOCR = jest.fn().mockResolvedValue(text('ocr text'));
    const input = attempt({ parse: jest.fn().mockResolvedValue(undefined), runConfiguredOCR });

    await expect(resolveDocumentExtraction(input)).resolves.toEqual(text('ocr text'));
    expect(runConfiguredOCR).toHaveBeenCalledWith({ throwOnMissingCapability: true });
  });

  it('keeps partial text when no OCR service can complete it, and fails closed first', async () => {
    const assertPartialTextAllowed = jest.fn();
    const parsed = text('partial', { pagesNeedingOcr: [3] });

    await expect(
      resolveDocumentExtraction(
        attempt({ parse: jest.fn().mockResolvedValue(parsed), assertPartialTextAllowed }),
      ),
    ).resolves.toEqual(parsed);
    expect(assertPartialTextAllowed).toHaveBeenCalledTimes(1);
  });

  it('refuses to persist partial text the content policy cannot inspect', async () => {
    const blocked = new Error('uninspectable');

    await expect(
      resolveDocumentExtraction(
        attempt({
          parse: jest.fn().mockResolvedValue(text('partial', { mayOmitContent: true })),
          assertPartialTextAllowed: jest.fn(() => {
            throw blocked;
          }),
        }),
      ),
    ).rejects.toBe(blocked);
  });

  /* The parser only reformats a CSV, and its conversion is bigger than the original, so
   * the refusal is the one case where the raw bytes are the better answer. */
  it('falls back to the raw bytes when a delimited conversion is refused on size', async () => {
    const readRawText = jest.fn().mockResolvedValue(text('a,b\n1,2\n', { rawDelimitedText: true }));
    const refusal = Object.assign(new Error('too large'), { code: 'PARSER_OUTPUT_LIMIT' });

    await expect(
      resolveDocumentExtraction(
        attempt({ delimitedText: true, parse: jest.fn().mockRejectedValue(refusal), readRawText }),
      ),
    ).resolves.toEqual(text('a,b\n1,2\n', { rawDelimitedText: true }));
  });

  it('surfaces a size refusal for a document with no readable raw form', async () => {
    const refusal = Object.assign(new Error('too large'), { code: 'PARSER_OUTPUT_LIMIT' });
    const readRawText = jest.fn();

    await expect(
      resolveDocumentExtraction(
        attempt({ parse: jest.fn().mockRejectedValue(refusal), readRawText }),
      ),
    ).rejects.toBe(refusal);
    expect(readRawText).not.toHaveBeenCalled();
  });

  it('reports nothing when no engine produced text', async () => {
    const runConfiguredOCR = jest.fn().mockResolvedValue(text('   '));

    await expect(
      resolveDocumentExtraction(
        attempt({ parse: jest.fn().mockResolvedValue(text('')), runConfiguredOCR }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('extraction outcome predicates', () => {
  it('reads a refusal from either the code or the class name', () => {
    expect(isDocumentParserRefusal({ code: 'ZIP_BOMB' })).toBe(true);
    expect(isDocumentParserRefusal({ name: 'ConcurrencyLimitError' })).toBe(true);
    /* The parser ran and found nothing: an outcome a configured OCR service answers,
     * not a refusal the caller reports as itself. */
    expect(isDocumentParserRefusal({ code: 'NO_DOCUMENT_TEXT' })).toBe(false);
    expect(isDocumentParserRefusal(new Error('boom'))).toBe(false);
  });

  it('calls a result partial when anything was left unread', () => {
    expect(isPartialDocumentText(text('body', { pagesNeedingOcr: [1] }))).toBe(true);
    expect(isPartialDocumentText(text('body', { mayOmitContent: true }))).toBe(true);
    expect(isPartialDocumentText(text('body', { pagesNeedingOcr: [] }))).toBe(false);
    expect(isPartialDocumentText(undefined)).toBe(false);
  });
});
