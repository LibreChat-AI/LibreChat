import { DEFAULT_MESSAGES_PAGE_SIZE, MAX_MESSAGES_PAGE_SIZE, parseMessagesPageSize } from './page';

describe('parseMessagesPageSize', () => {
  it('falls back to the default for missing, zero, negative, or non-numeric values', () => {
    for (const raw of [undefined, '', '0', '-5', 'abc', null, {}, ['10']]) {
      expect(parseMessagesPageSize(raw)).toBe(DEFAULT_MESSAGES_PAGE_SIZE);
    }
  });

  it('keeps values within the cap unchanged', () => {
    expect(parseMessagesPageSize('10')).toBe(10);
    expect(parseMessagesPageSize(String(MAX_MESSAGES_PAGE_SIZE))).toBe(MAX_MESSAGES_PAGE_SIZE);
  });

  it('clamps oversized values to the cap', () => {
    expect(parseMessagesPageSize('1000000')).toBe(MAX_MESSAGES_PAGE_SIZE);
  });

  it('honors a configured ceiling', () => {
    expect(parseMessagesPageSize('5000', 2000)).toBe(2000);
    expect(parseMessagesPageSize('50', 2000)).toBe(50);
  });
});
