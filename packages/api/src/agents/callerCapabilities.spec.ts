import { resolveCallerCapabilityProjectionSnapshot } from './callerCapabilities';

describe('resolveCallerCapabilityProjectionSnapshot', () => {
  it('accepts a complete v1 snapshot, including empty projections', () => {
    const snapshot = {
      version: 1 as const,
      directToolNames: [],
      codeExecutionToolNames: [],
      directOnlyToolNames: [],
      codeExecutionOnlyToolNames: [],
    };

    expect(resolveCallerCapabilityProjectionSnapshot(snapshot)).toBe(snapshot);
  });

  it('falls back for unknown versions and partial snapshots', () => {
    expect(
      resolveCallerCapabilityProjectionSnapshot({
        version: 2,
        directToolNames: [],
        codeExecutionToolNames: [],
        directOnlyToolNames: [],
        codeExecutionOnlyToolNames: [],
      }),
    ).toBeUndefined();
    expect(
      resolveCallerCapabilityProjectionSnapshot({
        version: 1,
        codeExecutionToolNames: [],
      }),
    ).toBeUndefined();
  });
});
