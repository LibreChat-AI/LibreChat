import type { CodeApprovalConstraints } from './approval';
import {
  CODE_APPROVAL_MODES,
  CodeApprovalModeError,
  getAllowedCodeApprovalModes,
  resolveCodeApprovalMode,
  resolveCodePermissionDecision,
} from './approval';

const constraints: CodeApprovalConstraints = {
  environment: 'attached',
  allowedModes: CODE_APPROVAL_MODES,
  configSchema: {
    permissions: {
      fileWrite: { allowed: ['ask', 'allow', 'deny'], default: 'ask' },
      commandExecution: { allowed: ['ask', 'allow', 'deny'], default: 'ask' },
    },
  },
};

describe('conversation code approval constraints', () => {
  test('defaults to asking without enabling unattended execution', () => {
    expect(getAllowedCodeApprovalModes({ environment: 'managed' })).toEqual(['ask']);
    expect(getAllowedCodeApprovalModes({ environment: 'attached' })).toEqual(['ask']);
    expect(resolveCodeApprovalMode(undefined, constraints)).toBeUndefined();
  });

  test('requires callers to identify attached environments before applying machine policy', () => {
    expect(
      getAllowedCodeApprovalModes({
        environment: 'managed',
        allowedModes: CODE_APPROVAL_MODES,
      }),
    ).toEqual(CODE_APPROVAL_MODES);
    expect(
      getAllowedCodeApprovalModes({
        ...constraints,
        configSchema: {
          permissions: {
            fileWrite: { allowed: ['ask'], default: 'ask' },
          },
        },
      }),
    ).toEqual(['ask']);
  });

  test('honors endpoint disablement and an explicit empty allowlist', () => {
    expect(getAllowedCodeApprovalModes({ ...constraints, enabled: false })).toEqual([]);
    expect(getAllowedCodeApprovalModes({ ...constraints, allowedModes: [] })).toEqual([]);
  });

  test('intersects deployment choices with machine policy in stable UI order', () => {
    expect(getAllowedCodeApprovalModes(constraints)).toEqual(CODE_APPROVAL_MODES);
    expect(
      getAllowedCodeApprovalModes({
        ...constraints,
        configSchema: {
          permissions: { fileWrite: constraints.configSchema?.permissions?.fileWrite },
        },
      }),
    ).toEqual(['ask', 'acceptEdits']);
    expect(getAllowedCodeApprovalModes({ ...constraints, configSchema: undefined })).toEqual([
      'ask',
    ]);
    expect(
      getAllowedCodeApprovalModes({ ...constraints, allowedModes: ['acceptEdits', 'ask'] }),
    ).toEqual(['ask', 'acceptEdits']);
  });

  test('never loosens an effective machine deny', () => {
    expect(
      getAllowedCodeApprovalModes({
        ...constraints,
        settings: { permissions: { fileWrite: 'deny' } },
      }),
    ).toEqual(['ask']);
    expect(
      getAllowedCodeApprovalModes({
        ...constraints,
        settings: { permissions: { commandExecution: 'deny' } },
      }),
    ).toEqual(['ask', 'acceptEdits']);
  });

  test('does not trust settings values excluded by the current schema', () => {
    expect(
      getAllowedCodeApprovalModes({
        ...constraints,
        settings: { permissions: { fileWrite: 'allow', commandExecution: 'allow' } },
        configSchema: {
          permissions: {
            fileWrite: { allowed: ['ask'], default: 'ask' },
            commandExecution: { allowed: ['ask'], default: 'ask' },
          },
        },
      }),
    ).toEqual(['ask']);
  });

  test.each(['autoApprove', 'bypass', 'invalidMode', '', {}, ['ask'], true, 1])(
    'rejects invalid request state: %j',
    (value) => {
      expect(() => resolveCodeApprovalMode(value, constraints)).toThrow(CodeApprovalModeError);
    },
  );

  test('rejects an unvalidated runtime mode before permission lookup', () => {
    expect(() =>
      resolveCodePermissionDecision({
        mode: 'invalidMode' as never,
        category: 'fileWrite',
        decision: 'ask',
      }),
    ).toThrow(CodeApprovalModeError);
  });

  test('revalidates a once-permitted selection after a policy restriction', () => {
    expect(resolveCodeApprovalMode('acceptEdits', constraints)).toBe('acceptEdits');
    expect(() =>
      resolveCodeApprovalMode('acceptEdits', { ...constraints, allowedModes: ['ask'] }),
    ).toThrow(CodeApprovalModeError);
  });

  test.each(CODE_APPROVAL_MODES)('preserves deny under %s', (mode) => {
    for (const category of ['fileWrite', 'commandExecution'] as const) {
      expect(resolveCodePermissionDecision({ mode, category, decision: 'deny' })).toBe('deny');
    }
  });

  test('full access allows commands and file writes only with both machine grants', () => {
    const mode = resolveCodeApprovalMode('fullAccess', constraints);
    for (const category of ['fileWrite', 'commandExecution'] as const) {
      expect(resolveCodePermissionDecision({ mode, category, decision: 'ask' })).toBe('allow');
      expect(() =>
        resolveCodeApprovalMode('fullAccess', {
          ...constraints,
          configSchema: {
            permissions: {
              ...constraints.configSchema?.permissions,
              [category]: { allowed: ['ask'], default: 'ask' },
            },
          },
        }),
      ).toThrow(CodeApprovalModeError);
    }
  });

  test('accept edits asks for commands and does not mutate its input', () => {
    const before = JSON.stringify(constraints);
    const mode = resolveCodeApprovalMode('acceptEdits', constraints);
    expect(resolveCodePermissionDecision({ mode, category: 'fileWrite', decision: 'ask' })).toBe(
      'allow',
    );
    expect(
      resolveCodePermissionDecision({ mode, category: 'commandExecution', decision: 'allow' }),
    ).toBe('ask');
    expect(JSON.stringify(constraints)).toBe(before);
  });
});
