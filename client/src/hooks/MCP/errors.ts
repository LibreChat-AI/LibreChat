import type { MCPReinitializeResponse } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';

export function getMCPReinitializeErrorMessage(
  response: MCPReinitializeResponse,
  localize: LocalizeFunction,
): string {
  switch (response.failureReason) {
    case 'unreachable':
      return localize('com_ui_mcp_server_connection_failed');
    case 'missing_custom_user_vars':
      return localize('com_ui_mcp_missing_custom_user_vars', {
        0: response.serverName,
        1: response.missingUserVars?.join(', ') ?? '',
      });
    case 'oauth_required':
      return localize('com_ui_mcp_reauthentication_required', { 0: response.serverName });
    default:
      return localize('com_ui_mcp_init_failed');
  }
}
