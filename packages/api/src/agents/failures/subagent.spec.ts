import { logger } from '@librechat/data-schemas';
import { SubagentResolutionError } from '@librechat/agents';
import type { SubagentResolutionDiagnostic } from '@librechat/agents';
import {
  describeErrorCauses,
  describeStackFrames,
  findMCPAuthenticationFailure,
  reportSubagentResolutionFailure,
} from './subagent';
import { MCPAuthenticationRefreshError, MCPAuthenticationRejectedError } from '~/mcp/errors';
import { ReauthenticationRequiredError } from '~/mcp/oauth/tokens';
import { OpenIDReauthRequiredError } from '~/utils/oidc';

const SECRET = 'provider-secret-value';

function diagnostic(
  overrides: Partial<SubagentResolutionDiagnostic> = {},
): SubagentResolutionDiagnostic {
  return {
    phase: 'config',
    subagentType: 'pr-reviewer',
    aborted: false,
    type: 'Error',
    cause: 'unknown',
    message: 'Subagent error: Unable to initialize the selected subagent.',
    parentRunId: 'run-1',
    childRunId: 'child-run-1',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('describeErrorCauses', () => {
  it('keeps name, code and status of every cause, but a message only from trusted errors', () => {
    const root = Object.assign(new Error(`Token refresh failed: api_key=${SECRET}`), {
      code: 'invalid_grant',
      status: 400,
    });
    const error = new SubagentResolutionError('config', 'unknown');
    Object.assign(error, { cause: root });

    const causes = describeErrorCauses(error);

    expect(causes).toEqual([
      {
        name: 'SubagentResolutionError',
        message: 'Subagent error: Unable to initialize the selected subagent.',
      },
      { name: 'Error', code: 'invalid_grant', status: 400 },
    ]);
    expect(JSON.stringify(causes)).not.toContain(SECRET);
  });

  it('stops at a cycle and at its depth bound', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.assign(first, { cause: second });
    expect(describeErrorCauses(first)).toHaveLength(2);

    let deep: unknown = new Error('0');
    for (let index = 1; index < 10; index++) {
      deep = new Error(String(index), { cause: deep });
    }
    expect(describeErrorCauses(deep)).toHaveLength(4);
  });

  it('describes values that are not errors without echoing them', () => {
    expect(describeErrorCauses(`plain failure ${SECRET}`)).toEqual([{ name: 'string' }]);
    expect(describeErrorCauses(undefined)).toEqual([]);
    expect(describeErrorCauses({ name: 'bad name with spaces', code: { nested: SECRET } })).toEqual(
      [{ name: 'UnknownError' }],
    );
  });
});

describe('describeStackFrames', () => {
  it('keeps where the error was thrown and drops its message', () => {
    const frames = describeStackFrames(new Error(`Authorization: Bearer ${SECRET}\nsecond line`));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(JSON.stringify(frames)).not.toContain(SECRET);
    expect(describeStackFrames('not an error')).toEqual([]);
  });

  it('never mistakes a message line shaped like a frame for one', () => {
    const injected = new Error(`provider said:${String.fromCharCode(10)}    at api_key=${SECRET}`);
    const frames = describeStackFrames(injected);
    expect(frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(frames)).not.toContain(SECRET);

    const rewritten = new Error('original');
    void rewritten.stack;
    rewritten.message = `rewritten ${SECRET}`;
    expect(describeStackFrames(rewritten)).toEqual([]);
  });
});

describe('findMCPAuthenticationFailure', () => {
  it('names the MCP server that needs re-authentication anywhere in the cause chain', () => {
    expect(
      findMCPAuthenticationFailure(
        new Error('child init failed', {
          cause: new ReauthenticationRequiredError('clickhouse-docs', 'expired'),
        }),
      ),
    ).toEqual({ serverName: 'clickhouse-docs', retryable: false });
    expect(
      findMCPAuthenticationFailure(new MCPAuthenticationRejectedError('github', false)),
    ).toEqual({ serverName: 'github', retryable: false });
  });

  it('marks failures that a retry may clear as retryable', () => {
    expect(findMCPAuthenticationFailure(new MCPAuthenticationRefreshError())).toEqual({
      retryable: true,
    });
    expect(
      findMCPAuthenticationFailure(new MCPAuthenticationRejectedError('github', true)),
    ).toEqual({ serverName: 'github', retryable: true });
  });

  it('does not treat a model provider or other HTTP 401 as an MCP sign-in', () => {
    expect(
      findMCPAuthenticationFailure(Object.assign(new Error('401 invalid_grant'), { status: 401 })),
    ).toBeUndefined();
    expect(findMCPAuthenticationFailure(new Error('Model not found'))).toBeUndefined();
    expect(
      findMCPAuthenticationFailure(new OpenIDReauthRequiredError('OpenID ID token is expired')),
    ).toBeUndefined();
  });
});

describe('reportSubagentResolutionFailure', () => {
  it('logs the underlying cause and the MCP server, and keeps the SDK classification', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = new Error(`Initialization failed: ${SECRET}`, {
      cause: new ReauthenticationRequiredError('clickhouse-docs', 'expired'),
    });

    const cause = reportSubagentResolutionFailure(diagnostic(), error);

    expect(cause).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[subagents] Subagent could not start: an MCP server it uses needs re-authentication',
      {
        phase: 'config',
        subagentType: 'pr-reviewer',
        cause: 'unknown',
        errorType: 'Error',
        aborted: false,
        taskId: 'task-1',
        childRunId: 'child-run-1',
        parentRunId: 'run-1',
        mcpAuthentication: { serverName: 'clickhouse-docs', retryable: false },
        causes: [
          { name: 'Error' },
          {
            name: 'ReauthenticationRequiredError',
            message:
              'Re-authentication required for "clickhouse-docs": access token expired and no refresh token available',
          },
        ],
        frames: expect.arrayContaining([expect.stringMatching(/^at /)]),
      },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    warn.mockRestore();
  });

  it('says a retry may succeed when the MCP sign-in failure is transient', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    reportSubagentResolutionFailure(diagnostic(), new MCPAuthenticationRefreshError());

    expect(warn).toHaveBeenCalledWith(
      '[subagents] Subagent could not start: an MCP server it uses could not authenticate; a retry may succeed',
      expect.objectContaining({ mcpAuthentication: { retryable: true } }),
    );
    warn.mockRestore();
  });

  it('logs other failures without an MCP reason', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    reportSubagentResolutionFailure(
      diagnostic({ phase: 'identity', taskId: undefined }),
      new Error('Agent not found'),
    );

    expect(warn).toHaveBeenCalledWith('[subagents] Subagent could not start', {
      phase: 'identity',
      subagentType: 'pr-reviewer',
      cause: 'unknown',
      errorType: 'Error',
      aborted: false,
      childRunId: 'child-run-1',
      parentRunId: 'run-1',
      causes: [{ name: 'Error' }],
      frames: expect.any(Array),
    });
    warn.mockRestore();
  });
});
