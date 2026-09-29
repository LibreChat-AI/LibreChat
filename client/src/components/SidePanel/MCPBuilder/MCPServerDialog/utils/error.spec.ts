import type { TranslationKeys } from '~/hooks';

import { getMCPServerErrorMessage } from './error';

const localize = (key: TranslationKeys): string => `localized:${key}`;

describe('getMCPServerErrorMessage', () => {
  it.each([
    ['MCP_API_KEY_REENTRY_REQUIRED', 'com_ui_mcp_api_key_reentry_required'],
    ['MCP_INSPECTION_FAILED', 'com_ui_mcp_server_connection_failed'],
    ['MCP_DOMAIN_NOT_ALLOWED', 'com_ui_mcp_domain_not_allowed'],
    ['MCP_OAUTH_SECRET_REENTRY_REQUIRED', 'com_ui_mcp_oauth_secret_reentry_required'],
  ] as const)('localizes %s', (errorCode, messageKey) => {
    expect(getMCPServerErrorMessage(errorCode, localize)).toBe(`localized:${messageKey}`);
  });

  it('returns an unknown server error unchanged', () => {
    expect(getMCPServerErrorMessage('UNKNOWN_ERROR', localize)).toBe('UNKNOWN_ERROR');
  });
});
