import {
  DEFAULT_MESSAGES_PAGE_SIZE,
  MAX_MESSAGES_PAGE_SIZE,
  parseMessagesPageSize,
  resolveMessagesPageSize,
  awaitPageSize,
} from './page';

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
    expect(parseMessagesPageSize(undefined, 10)).toBe(10);
  });
});

describe('resolveMessagesPageSize', () => {
  const user = { id: 'u1', role: 'USER' };

  it('applies the configured ceiling', async () => {
    const getAppConfig = jest.fn().mockResolvedValue({ messages: { maxPageSize: 40 } });
    await expect(resolveMessagesPageSize(user, '500', { getAppConfig })).resolves.toBe(40);
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ skipRuntimeAugmentation: true }),
    );
  });

  it('keeps the default ceiling when no limit is configured', async () => {
    const getAppConfig = jest.fn().mockResolvedValue({});
    await expect(resolveMessagesPageSize(user, '5000', { getAppConfig })).resolves.toBe(
      MAX_MESSAGES_PAGE_SIZE,
    );
  });

  it('falls back to the default ceiling when config is unavailable', async () => {
    const getAppConfig = jest.fn().mockRejectedValue(new Error('down'));
    await expect(resolveMessagesPageSize(user, '5000', { getAppConfig })).resolves.toBe(
      MAX_MESSAGES_PAGE_SIZE,
    );
  });
});

describe('awaitPageSize', () => {
  it('returns the page size and leaves a rejecting sibling read awaitable', async () => {
    const failing = Promise.reject(new Error('db down'));
    const size = await awaitPageSize(
      new Promise<number>((resolve) => setTimeout(() => resolve(40), 5)),
      failing,
    );
    expect(size).toBe(40);
    await expect(failing).rejects.toThrow('db down');
  });
});
