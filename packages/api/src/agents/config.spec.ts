import type { TAgentsEndpoint } from 'librechat-data-provider';
import {
  resolveStreamLimits,
  resolveRecursionLimit,
  resolveSubagentMaxTurns,
  resolveModelTransportTimeouts,
} from './config';

describe('resolveRecursionLimit', () => {
  it('returns default 50 when no config or agent provided', () => {
    expect(resolveRecursionLimit(undefined, undefined)).toBe(50);
  });

  it('returns default 50 when config has no recursionLimit', () => {
    expect(resolveRecursionLimit({} as TAgentsEndpoint, {})).toBe(50);
  });

  it('uses yaml recursionLimit when set', () => {
    const config = { recursionLimit: 100 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, {})).toBe(100);
  });

  it('overrides with agent.recursion_limit when set', () => {
    const config = { recursionLimit: 100 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 200 })).toBe(200);
  });

  it('caps at maxRecursionLimit', () => {
    const config = { recursionLimit: 100, maxRecursionLimit: 150 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 200 })).toBe(150);
  });

  it('caps yaml default at maxRecursionLimit', () => {
    const config = { recursionLimit: 200, maxRecursionLimit: 100 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, {})).toBe(100);
  });

  it('ignores agent.recursion_limit of 0', () => {
    const config = { recursionLimit: 100 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 0 })).toBe(100);
  });

  it('ignores negative agent.recursion_limit', () => {
    const config = { recursionLimit: 100 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: -5 })).toBe(100);
  });

  it('ignores maxRecursionLimit of 0', () => {
    const config = { recursionLimit: 100, maxRecursionLimit: 0 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 200 })).toBe(200);
  });

  it('does not cap when recursionLimit is within maxRecursionLimit', () => {
    const config = { recursionLimit: 50, maxRecursionLimit: 200 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 150 })).toBe(150);
  });

  it('allows agent to override downward below yaml default', () => {
    const config = { recursionLimit: 100 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 30 })).toBe(30);
  });

  it('does not cap when agent.recursion_limit equals maxRecursionLimit', () => {
    const config = { recursionLimit: 50, maxRecursionLimit: 150 } as TAgentsEndpoint;
    expect(resolveRecursionLimit(config, { recursion_limit: 150 })).toBe(150);
  });
});

describe('resolveSubagentMaxTurns', () => {
  it('tracks the default resolved limit (50 -> 16 turns / 48 graph steps)', () => {
    expect(resolveSubagentMaxTurns(undefined, undefined)).toBe(16);
  });

  it('derives maxTurns from the per-agent recursion_limit so the graph limit tracks it', () => {
    const config = { recursionLimit: 50, maxRecursionLimit: 1000 } as TAgentsEndpoint;
    expect(resolveSubagentMaxTurns(config, { recursion_limit: 500 })).toBe(166);
  });

  it('derives maxTurns from the yaml recursionLimit default', () => {
    const config = { recursionLimit: 300 } as TAgentsEndpoint;
    expect(resolveSubagentMaxTurns(config, {})).toBe(100);
  });

  it('honors an explicit recursion limit below the historical 75-step default', () => {
    const config = { recursionLimit: 45 } as TAgentsEndpoint;
    const turns = resolveSubagentMaxTurns(config, {});
    expect(turns).toBe(15);
    expect(turns * 3).toBeLessThanOrEqual(45);
  });

  it('honors a per-agent recursion_limit lowered below the yaml default', () => {
    const config = { recursionLimit: 300 } as TAgentsEndpoint;
    const turns = resolveSubagentMaxTurns(config, { recursion_limit: 30 });
    expect(turns).toBe(10);
    expect(turns * 3).toBeLessThanOrEqual(30);
  });

  it('never exceeds maxRecursionLimit when it caps the resolved limit', () => {
    const config = { recursionLimit: 100, maxRecursionLimit: 150 } as TAgentsEndpoint;
    const turns = resolveSubagentMaxTurns(config, { recursion_limit: 600 });
    expect(turns).toBe(50);
    expect(turns * 3).toBeLessThanOrEqual(150);
  });

  it('never exceeds a small maxRecursionLimit', () => {
    const config = { maxRecursionLimit: 20 } as TAgentsEndpoint;
    const turns = resolveSubagentMaxTurns(config, {});
    expect(turns).toBe(6);
    expect(turns * 3).toBeLessThanOrEqual(20);
  });

  it('yields 0 turns when the resolved cap is below the multiplier (never exceeds it)', () => {
    const config = { maxRecursionLimit: 2 } as TAgentsEndpoint;
    const turns = resolveSubagentMaxTurns(config, {});
    expect(turns).toBe(0);
    expect(turns * 3).toBeLessThanOrEqual(2);
  });
});

describe('resolveModelTransportTimeouts', () => {
  it('uses finite defaults and preserves explicit overrides including zero', () => {
    expect(resolveModelTransportTimeouts(undefined)).toEqual({
      bodyTimeout: 900_000,
      headersTimeout: 300_000,
    });
    expect(
      resolveModelTransportTimeouts({
        modelResponseBodyTimeoutMs: 1_800_000,
        modelResponseHeadersTimeoutMs: 0,
      }),
    ).toEqual({ bodyTimeout: 1_800_000, headersTimeout: 0 });
  });
});

describe('resolveStreamLimits', () => {
  const CREATE_FILE_DEFAULT = { create_file: 131072 };

  it('ships only the create_file override when no yaml fields are set, so SDK defaults apply', () => {
    expect(resolveStreamLimits(undefined)).toEqual({
      maxToolCallArgBytesByTool: CREATE_FILE_DEFAULT,
    });
    expect(resolveStreamLimits({} as TAgentsEndpoint)).toEqual({
      maxToolCallArgBytesByTool: CREATE_FILE_DEFAULT,
    });
  });

  it('maps both global yaml fields onto the SDK streamLimits shape', () => {
    const config = {
      maxToolCallArgBytes: 131072,
      maxDeltaEventsPerTurn: 100000,
    } as TAgentsEndpoint;
    expect(resolveStreamLimits(config)).toEqual({
      maxToolCallArgBytes: 131072,
      maxToolCallArgBytesByTool: CREATE_FILE_DEFAULT,
      maxDeltaEventsPerTurn: 100000,
    });
  });

  it('passes each global field independently, omitting the unset one', () => {
    expect(resolveStreamLimits({ maxToolCallArgBytes: 1024 } as TAgentsEndpoint)).toEqual({
      maxToolCallArgBytes: 1024,
      maxToolCallArgBytesByTool: CREATE_FILE_DEFAULT,
    });
    expect(resolveStreamLimits({ maxDeltaEventsPerTurn: 5000 } as TAgentsEndpoint)).toEqual({
      maxToolCallArgBytesByTool: CREATE_FILE_DEFAULT,
      maxDeltaEventsPerTurn: 5000,
    });
  });

  it('passes an explicit 0 through so admins can disable the SDK default', () => {
    expect(resolveStreamLimits({ maxToolCallArgBytes: 0 } as TAgentsEndpoint)).toEqual({
      maxToolCallArgBytes: 0,
      maxToolCallArgBytesByTool: CREATE_FILE_DEFAULT,
    });
  });

  it('merges yaml per-tool entries over the shipped create_file default', () => {
    expect(resolveStreamLimits({ maxToolCallArgBytesByTool: { my_mcp_tool: 32768 } })).toEqual({
      maxToolCallArgBytesByTool: { create_file: 131072, my_mcp_tool: 32768 },
    });
  });

  it('lets a yaml create_file entry replace the shipped default, including 0 to disable', () => {
    expect(resolveStreamLimits({ maxToolCallArgBytesByTool: { create_file: 262144 } })).toEqual({
      maxToolCallArgBytesByTool: { create_file: 262144 },
    });
    expect(resolveStreamLimits({ maxToolCallArgBytesByTool: { create_file: 0 } })).toEqual({
      maxToolCallArgBytesByTool: { create_file: 0 },
    });
  });
});
