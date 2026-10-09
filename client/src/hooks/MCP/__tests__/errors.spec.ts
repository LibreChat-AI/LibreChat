import type { MCPReinitializeResponse } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import { getMCPReinitializeErrorMessage } from '../errors';

const localize = jest.fn((key: string) => key) as unknown as jest.MockedFunction<LocalizeFunction>;

const createResponse = (
  overrides: Partial<MCPReinitializeResponse> = {},
): MCPReinitializeResponse => ({
  success: false,
  message: 'Raw backend message that must not be displayed',
  serverName: 'ClickHouse',
  ...overrides,
});

describe('getMCPReinitializeErrorMessage', () => {
  beforeEach(() => {
    localize.mockClear();
  });

  it('localizes unreachable servers with the existing connection guidance', () => {
    const message = getMCPReinitializeErrorMessage(
      createResponse({ failureReason: 'unreachable' }),
      localize,
    );

    expect(message).toBe('com_ui_mcp_server_connection_failed');
    expect(localize).toHaveBeenCalledWith('com_ui_mcp_server_connection_failed');
  });

  it('localizes missing variables with the server and variable names', () => {
    const message = getMCPReinitializeErrorMessage(
      createResponse({
        failureReason: 'missing_custom_user_vars',
        missingUserVars: ['API_KEY', 'ACCOUNT_ID'],
      }),
      localize,
    );

    expect(message).toBe('com_ui_mcp_missing_custom_user_vars');
    expect(localize).toHaveBeenCalledWith('com_ui_mcp_missing_custom_user_vars', {
      0: 'ClickHouse',
      1: 'API_KEY, ACCOUNT_ID',
    });
  });

  it('localizes an OAuth failure that requires reauthentication', () => {
    const message = getMCPReinitializeErrorMessage(
      createResponse({ failureReason: 'oauth_required' }),
      localize,
    );

    expect(message).toBe('com_ui_mcp_reauthentication_required');
    expect(localize).toHaveBeenCalledWith('com_ui_mcp_reauthentication_required', {
      0: 'ClickHouse',
    });
  });

  it('uses the localized fallback instead of exposing unknown backend messages', () => {
    const message = getMCPReinitializeErrorMessage(createResponse(), localize);

    expect(message).toBe('com_ui_mcp_init_failed');
    expect(message).not.toContain('Raw backend message');
    expect(localize).toHaveBeenCalledWith('com_ui_mcp_init_failed');
  });
});
