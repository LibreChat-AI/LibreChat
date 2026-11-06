import { logger } from '@librechat/data-schemas';
import { getSubagentResolutionFailureMessage } from '@librechat/agents';
import {
  createExpectedMCPToolsUnavailableError,
  createMCPToolsFailureContext,
  classifySubagentResolutionFailure,
  isFatalAgentInitializationError,
} from './errors';
import { MCPAuthenticationRejectedError, MCPAuthenticationRefreshError } from '~/mcp/errors';
import { OboTokenResolutionError } from '~/mcp/oauth/obo';
import { OpenIDReauthRequiredError } from '~/utils/oidc';

const privateText = 'private bearer and provider payload';
const detail = {
  phase: 'config',
  subagentType: 'specialist',
  aborted: false,
  type: 'Error',
  cause: 'unknown',
  message: getSubagentResolutionFailureMessage('unknown'),
} as const;

describe('subagent MCP startup failures', () => {
  it.each([
    [
      new MCPAuthenticationRejectedError('private-server', false, new Error(privateText)),
      'authentication_required',
    ],
    [new OpenIDReauthRequiredError(privateText), 'authentication_required'],
    [new MCPAuthenticationRejectedError('private-server', true), 'tools_unavailable'],
    [new MCPAuthenticationRefreshError(new Error(privateText)), 'tools_unavailable'],
    [
      new OboTokenResolutionError(
        'missing_upstream_token',
        privateText,
        false,
        new Error(privateText),
      ),
      'authentication_required',
    ],
    [
      new OboTokenResolutionError('exchange_failed', privateText, true, new Error(privateText)),
      'tools_unavailable',
    ],
    [new Error(privateText), 'unknown'],
    [Object.assign(new Error(privateText), { code: 'MCP_AUTHENTICATION_REJECTED' }), 'unknown'],
  ])('classifies typed failures without inspecting error text', (error, expected) => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const cause = classifySubagentResolutionFailure(detail, error);
    expect(cause).toBe(expected);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-server');
    expect(getSubagentResolutionFailureMessage(cause)).not.toContain(privateText);
  });

  it.each([
    [[], 'tools_unavailable'],
    [[{ oauthRequired: false }], 'tools_unavailable'],
    [[{ oauthRequired: true }], 'authentication_required'],
    [[{ oauthRequired: true }, { oauthRequired: false }], 'authentication_required'],
  ] as const)(
    'preserves the loader policy and retains only a typed reason',
    (outcomes, expected) => {
      jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const context = createMCPToolsFailureContext('private-agent');
      outcomes.forEach((result) => context.recordOAuthResult(result));
      const error = context.createError(new Error(privateText));
      expect(error).toMatchObject({
        name: 'AgentToolInitializationError',
        status: 503,
        statusCode: 503,
      });
      expect(isFatalAgentInitializationError(error)).toBe(true);
      expect(isFatalAgentInitializationError(error, { allowExpectedMCPFallback: true })).toBe(
        false,
      );
      expect(classifySubagentResolutionFailure(detail, error)).toBe(expected);
      expect(
        getSubagentResolutionFailureMessage(classifySubagentResolutionFailure(detail, error)),
      ).not.toContain('private-agent');
    },
  );

  it('keeps OAuth outcomes scoped to one loader request', () => {
    const pending = createMCPToolsFailureContext();
    const separate = createMCPToolsFailureContext();
    pending.recordOAuthResult({ oauthRequired: true });
    expect(pending.createError().reason).toBe('authentication_required');
    expect(separate.createError().reason).toBe('tools_unavailable');
    expect(createExpectedMCPToolsUnavailableError().reason).toBe('tools_unavailable');
  });

  it('selects actionable SDK messages for the two host-owned outcomes', () => {
    expect(getSubagentResolutionFailureMessage('authentication_required')).toContain(
      'Complete the sign-in prompt',
    );
    expect(getSubagentResolutionFailureMessage('tools_unavailable')).toContain(
      'Required tools are unavailable',
    );
  });

  it('keeps cancellation separate from authentication recovery', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(
      classifySubagentResolutionFailure(
        { ...detail, aborted: true },
        new MCPAuthenticationRejectedError('private', false),
      ),
    ).toBe('unknown');
  });
});
