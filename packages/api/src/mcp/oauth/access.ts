import { MCPOAuthHandler } from './handler';

/** HTTP flow readers must never expose internal system credentials. */
export function canAccessMCPOAuthFlow(flowId: string, userId: string, tenantId?: string): boolean {
  const parsed = MCPOAuthHandler.parseFlowId(flowId);
  if (!parsed || parsed.userId === 'system') {
    return false;
  }
  if (parsed.tenantId && parsed.tenantId !== tenantId) {
    return false;
  }
  return parsed.userId === userId;
}
