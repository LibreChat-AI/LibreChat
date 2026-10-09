import { validateCodeEnvironmentUserSettings } from './settings';

describe('validateCodeEnvironmentUserSettings', () => {
  test('accepts only permission values exposed by the administrator', () => {
    expect(
      validateCodeEnvironmentUserSettings(
        {
          permissions: {
            fileWrite: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
            commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
          },
        },
        { permissions: { fileWrite: 'allow', commandExecution: 'deny' } },
      ),
    ).toEqual({ permissions: { fileWrite: 'allow', commandExecution: 'deny' } });
  });

  test('rejects hidden fields and values outside the administrator allowlist', () => {
    expect(() =>
      validateCodeEnvironmentUserSettings(
        {
          permissions: {
            commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
          },
        },
        { permissions: { fileWrite: 'allow' } },
      ),
    ).toThrow('fileWrite is not configurable');

    expect(() =>
      validateCodeEnvironmentUserSettings(
        {
          permissions: {
            commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
          },
        },
        { permissions: { commandExecution: 'allow' } },
      ),
    ).toThrow('commandExecution is not configurable');
  });
});
