jest.mock('../connect', () => jest.fn(() => new Promise(() => {})));

describe('Invite user CLI', () => {
  it('loads its runtime dependencies', () => {
    const existingHandlers = new Set(process.listeners('uncaughtException'));

    try {
      expect(() => require('../invite-user')).not.toThrow();
    } finally {
      process
        .listeners('uncaughtException')
        .filter((handler) => !existingHandlers.has(handler))
        .forEach((handler) => process.removeListener('uncaughtException', handler));
    }
  });
});
