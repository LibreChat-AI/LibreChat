/**
 * Specs in the `api` workspace mock `@librechat/data-schemas` down to its logger and still load
 * this package, so loading it must not read any other data-schemas export.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe('@librechat/api entry', () => {
  it('loads where @librechat/data-schemas is mocked down to its logger', () => {
    expect(() => jest.requireActual('./index')).not.toThrow();
  });
});
