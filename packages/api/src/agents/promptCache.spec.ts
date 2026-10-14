import { isStableContextEnabled, orderNames } from './promptCache';

const ON = { endpoints: { agents: { promptCache: { stableContext: true } } } };

describe('isStableContextEnabled', () => {
  it('is off unless configured', () => {
    expect(isStableContextEnabled(undefined)).toBe(false);
    expect(isStableContextEnabled(null)).toBe(false);
    expect(isStableContextEnabled({})).toBe(false);
    expect(isStableContextEnabled({ endpoints: { agents: {} } })).toBe(false);
    expect(
      isStableContextEnabled({ endpoints: { agents: { promptCache: { stableContext: false } } } }),
    ).toBe(false);
  });

  it('is on when configured and the SDK has the dispatcher', () => {
    expect(isStableContextEnabled(ON)).toBe(true);
  });
});

describe('orderNames', () => {
  it('sorts by code unit with stableContext and keeps the given order without', () => {
    const names = new Set(['b', 'A', 'a']);
    expect(orderNames(ON, names)).toEqual(['A', 'a', 'b']);
    expect(orderNames({}, names)).toEqual(['b', 'A', 'a']);
  });
});

describe('without a tool dispatcher in the installed SDK', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@librechat/agents');
  });

  it('behaves as off and warns once', () => {
    const warn = jest.fn();
    jest.resetModules();
    jest.doMock('@librechat/agents', () => ({}));
    jest.doMock('@librechat/data-schemas', () => ({ logger: { warn } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const promptCache = require('./promptCache') as typeof import('./promptCache');
    expect(promptCache.isStableContextEnabled(ON)).toBe(false);
    expect(promptCache.isStableContextEnabled(ON)).toBe(false);
    expect(promptCache.orderNames(ON, ['b', 'a'])).toEqual(['b', 'a']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no tool dispatcher');
  });
});
