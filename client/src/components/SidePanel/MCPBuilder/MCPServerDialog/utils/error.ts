import type { TranslationKeys } from '~/hooks';

type Localize = (key: TranslationKeys) => string;

const MCP_ERROR_MESSAGE_KEYS: Record<string, TranslationKeys> = {
  MCP_API_KEY_REENTRY_REQUIRED: 'com_ui_mcp_api_key_reentry_required',
  MCP_INSPECTION_FAILED: 'com_ui_mcp_server_connection_failed',
  MCP_DOMAIN_NOT_ALLOWED: 'com_ui_mcp_domain_not_allowed',
  MCP_OAUTH_SECRET_REENTRY_REQUIRED: 'com_ui_mcp_oauth_secret_reentry_required',
};

export function getMCPServerErrorMessage(errorCode: string, localize: Localize): string {
  const messageKey = MCP_ERROR_MESSAGE_KEYS[errorCode];
  return messageKey ? localize(messageKey) : errorCode;
}
