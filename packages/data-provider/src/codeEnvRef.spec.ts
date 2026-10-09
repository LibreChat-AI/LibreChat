import type { CodeEnvKind, CodeEnvRef } from './codeEnvRef';
import {
  CODE_ENV_KINDS,
  getCodeEnvRefForProfile,
  getCodeEnvRefs,
  mergeCodeEnvRef,
} from './codeEnvRef';

describe('CodeEnvRef', () => {
  it('accepts the canonical shape for kind: skill', () => {
    const ref: CodeEnvRef = {
      kind: 'skill',
      id: 'skill_123',
      storage_session_id: 'sess_abc',
      file_id: 'file_xyz',
      version: 7,
    };
    expect(ref.kind).toBe('skill');
    expect(ref.version).toBe(7);
  });

  it('accepts the canonical shape for kind: user', () => {
    const ref: CodeEnvRef = {
      kind: 'user',
      id: 'user_456',
      storage_session_id: 'sess_def',
      file_id: 'file_uvw',
    };
    expect(ref.kind).toBe('user');
    /* `version` is statically absent on the user variant of the
     * discriminated union — the property doesn't exist on the type, so
     * accessing it would be a compile error. Probe at runtime via an
     * `unknown` cast to assert the absence at runtime as well. */
    expect((ref as unknown as Record<string, unknown>).version).toBeUndefined();
  });

  it('accepts the canonical shape for kind: agent', () => {
    const ref: CodeEnvRef = {
      kind: 'agent',
      id: 'agent_789',
      storage_session_id: 'sess_ghi',
      file_id: 'file_rst',
    };
    expect(ref.kind).toBe('agent');
  });

  it('CODE_ENV_KINDS pins the closed set of kinds', () => {
    /* Adding a new kind requires updating the runtime tuple AND
     * surfacing it in `resolveSessionKey`'s exhaustive switch. The
     * `as const` shape makes this catch-able by the type system. */
    const kinds: CodeEnvKind[] = [...CODE_ENV_KINDS];
    expect(kinds).toEqual(['skill', 'agent', 'user']);
  });

  it('retains independent pointers for default and stateful deployments', () => {
    const defaultRef: CodeEnvRef = {
      kind: 'user',
      id: 'user-1',
      storage_session_id: 'default-session',
      file_id: 'default-file',
      executionProfile: 'default',
    };
    const statefulRef: CodeEnvRef = {
      ...defaultRef,
      storage_session_id: 'stateful-session',
      file_id: 'stateful-file',
      executionProfile: 'stateful',
    };

    const refs = mergeCodeEnvRef(mergeCodeEnvRef(undefined, defaultRef), statefulRef);

    expect(getCodeEnvRefForProfile(refs, 'default')).toBe(defaultRef);
    expect(getCodeEnvRefForProfile(refs, 'stateful')).toBe(statefulRef);
    expect(getCodeEnvRefs(refs)).toEqual([
      ['default', defaultRef],
      ['stateful', statefulRef],
    ]);
    expect(refs.codeEnvRef).toBe(defaultRef);
  });

  it('treats a legacy pointer without a profile as default-only', () => {
    const legacy: CodeEnvRef = {
      kind: 'agent',
      id: 'agent-1',
      storage_session_id: 'legacy-session',
      file_id: 'legacy-file',
    };
    expect(getCodeEnvRefForProfile({ codeEnvRef: legacy }, 'default')).toBe(legacy);
    expect(getCodeEnvRefForProfile({ codeEnvRef: legacy }, 'stateful')).toBeUndefined();
  });

  it('retains independent pointers for configured environments sharing one profile', () => {
    const first: CodeEnvRef = {
      kind: 'skill',
      id: 'skill-1',
      version: 1,
      storage_session_id: 'first-session',
      file_id: 'first-file',
      executionProfile: 'stateful',
      executionRouteKey: 'stateful:first',
    };
    const second: CodeEnvRef = {
      ...first,
      storage_session_id: 'second-session',
      file_id: 'second-file',
      executionRouteKey: 'stateful:second',
    };

    const refs = mergeCodeEnvRef(mergeCodeEnvRef(undefined, first), second);

    expect(getCodeEnvRefForProfile(refs, 'stateful:first')).toBe(first);
    expect(getCodeEnvRefForProfile(refs, 'stateful:second')).toBe(second);
    expect(Object.keys(refs.codeEnvRefs)).toEqual(['stateful:first', 'stateful:second']);
  });
});
